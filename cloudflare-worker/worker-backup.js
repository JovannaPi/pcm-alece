// Worker Cloudflare — cópia automática dos dados do PMOC pra uma Planilha
// Google. Roda sozinho todo dia (Cron Trigger, configurado no painel da
// Cloudflare, não aqui no código) e serve três coisas de uma vez:
//   1. Uma "visão de banco de dados" de tudo que está no sistema, em
//      formato de planilha, filtrável.
//   2. Um backup fora do Firebase, atualizado automaticamente.
//   3. Uma fonte de dados pronta pra plugar no Looker Studio (BI) depois.
//
// Como funciona: usa uma "conta de serviço" do Google (Service Account) —
// diferente do login de uma pessoa, é uma credencial de robô que a gente
// autoriza a ler o Firestore inteiro e escrever numa planilha específica.
//
// Variáveis de ambiente que esse Worker precisa (Settings > Variables and
// Secrets, todas como "Secret", exceto a última que pode ser texto normal):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL   (do arquivo JSON da conta de serviço)
//   GOOGLE_PRIVATE_KEY             (idem — o campo "private_key" inteiro,
//                                    incluindo as linhas -----BEGIN/END-----)
//   FIREBASE_PROJECT_ID            (= "pcm-alece")
//   GOOGLE_SHEET_ID                (o ID da planilha — vem no link dela,
//                                    entre "/d/" e "/edit")
//
// A planilha precisa ter 6 abas, com esses nomes exatos:
//   Equipamentos, Historico, Ordens, Auditoria, Feriados, Equipes
//
// E precisa estar COMPARTILHADA (botão "Compartilhar" na planilha) com o
// e-mail da conta de serviço, com permissão de Editor.

const ESCOPOS_GOOGLE = "https://www.googleapis.com/auth/datastore.readonly https://www.googleapis.com/auth/spreadsheets";

function base64Url(bytes) {
  let binario = "";
  bytes.forEach((b) => (binario += String.fromCharCode(b)));
  return btoa(binario).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlTexto(texto) {
  return base64Url(new TextEncoder().encode(texto));
}

async function importarChavePrivada(pem) {
  const corpo = pem
    .replace(/\\n/g, "\n") // caso a quebra de linha tenha vindo como texto "\n" em vez de quebra de linha de verdade
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const bytes = Uint8Array.from(atob(corpo), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    bytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

// Autentica como a conta de serviço e devolve um token de acesso do Google,
// válido por 1 hora, com permissão de ler o Firestore e escrever na planilha.
async function obterAccessTokenGoogle(env) {
  const agora = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claimSet = {
    iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: ESCOPOS_GOOGLE,
    aud: "https://oauth2.googleapis.com/token",
    iat: agora,
    exp: agora + 3600,
  };
  const semAssinar = `${base64UrlTexto(JSON.stringify(header))}.${base64UrlTexto(JSON.stringify(claimSet))}`;
  const chave = await importarChavePrivada(env.GOOGLE_PRIVATE_KEY);
  const assinatura = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    chave,
    new TextEncoder().encode(semAssinar)
  );
  const jwt = `${semAssinar}.${base64Url(new Uint8Array(assinatura))}`;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${jwt}`,
  });
  const dados = await resp.json();
  if (!resp.ok) throw new Error("Falha ao autenticar com o Google: " + (dados.error_description || dados.error));
  return dados.access_token;
}

// Converte o formato "tipado" do Firestore (campo.stringValue,
// campo.integerValue etc) num objeto JS comum.
function lerValorFirestore(valor) {
  if (valor.stringValue !== undefined) return valor.stringValue;
  if (valor.integerValue !== undefined) return Number(valor.integerValue);
  if (valor.doubleValue !== undefined) return valor.doubleValue;
  if (valor.booleanValue !== undefined) return valor.booleanValue;
  if (valor.arrayValue !== undefined) {
    return (valor.arrayValue.values || []).map(lerValorFirestore).join(", ");
  }
  if (valor.nullValue !== undefined) return "";
  return "";
}

function documentoParaObjeto(doc) {
  const obj = { id: doc.name.split("/").pop() };
  const campos = doc.fields || {};
  for (const chave of Object.keys(campos)) {
    obj[chave] = lerValorFirestore(campos[chave]);
  }
  return obj;
}

async function listarColecao(caminho, token, env) {
  const documentos = [];
  let pageToken = "";
  do {
    const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${caminho}?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const dados = await resp.json();
    if (!resp.ok) throw new Error(`Falha ao ler ${caminho}: ${dados.error?.message || resp.status}`);
    (dados.documents || []).forEach((doc) => documentos.push(documentoParaObjeto(doc)));
    pageToken = dados.nextPageToken || "";
  } while (pageToken);
  return documentos;
}

async function cicloAtualId(token, env) {
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/ciclos?orderBy=criadoEm desc&pageSize=1`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const dados = await resp.json();
  if (!resp.ok || !dados.documents?.length) return null;
  return dados.documents[0].name.split("/").pop();
}

async function escreverAba(nomeAba, colunas, linhas, token, env) {
  const valores = [colunas, ...linhas.map((obj) => colunas.map((c) => (obj[c] ?? "").toString()))];
  const range = `${nomeAba}!A1`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: valores }),
  });
  if (!resp.ok) {
    const erro = await resp.json().catch(() => ({}));
    throw new Error(`Falha ao escrever na aba ${nomeAba}: ${erro.error?.message || resp.status}`);
  }
}

async function rodarBackup(env) {
  const token = await obterAccessTokenGoogle(env);
  const cicloId = await cicloAtualId(token, env);

  const [equipamentos, historico, ordens, auditoria, feriados, equipes] = await Promise.all([
    cicloId ? listarColecao(`ciclos/${cicloId}/equipamentos`, token, env) : [],
    cicloId ? listarColecao(`ciclos/${cicloId}/historico`, token, env) : [],
    cicloId ? listarColecao(`ciclos/${cicloId}/ordens`, token, env) : [],
    listarColecao("auditoria", token, env),
    listarColecao("feriados", token, env),
    listarColecao("equipes", token, env),
  ]);

  await escreverAba("Equipamentos", [
    "id", "patrimonio", "setor", "ambiente", "local", "setorPCM", "equipeResponsavel",
    "statusPreventiva", "dataAgendada", "diaPlanejado", "semanaPlanejada", "origem",
    "marca", "modelo", "capacidade", "fotoUrl",
  ], equipamentos, token, env);

  await escreverAba("Historico", [
    "id", "equipamentoId", "patrimonio", "setor", "ambiente", "local", "equipe", "usuario",
    "tipo", "statusAnterior", "statusNovo", "fotoUrl", "registradoEm",
  ], historico, token, env);

  await escreverAba("Ordens", [
    "id", "equipamentoId", "patrimonio", "setor", "ambiente", "local", "equipe",
    "dataAgendada", "status", "tecnico", "avaliacaoEstrelas", "checklist", "registradoEm",
  ], ordens, token, env);

  await escreverAba("Auditoria", [
    "id", "acao", "detalhes", "usuario", "registradoEm",
  ], auditoria, token, env);

  await escreverAba("Feriados", [
    "id", "tipo", "label", "dataInicio", "dataFim",
  ], feriados, token, env);

  await escreverAba("Equipes", [
    "id", "predio", "ordem", "nome",
  ], equipes, token, env);

  return {
    equipamentos: equipamentos.length,
    historico: historico.length,
    ordens: ordens.length,
    auditoria: auditoria.length,
    feriados: feriados.length,
    equipes: equipes.length,
  };
}

export default {
  // Roda sozinho, no horário configurado em Settings > Triggers > Cron Triggers.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(rodarBackup(env));
  },

  // Também dá pra rodar manualmente visitando a URL do Worker no navegador
  // (útil pra testar sem esperar o horário programado).
  async fetch(request, env) {
    try {
      const resumo = await rodarBackup(env);
      return new Response(JSON.stringify({ ok: true, resumo }, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, erro: err.message }, null, 2), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
};
