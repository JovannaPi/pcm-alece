import { db, auth, firebaseConfig } from "./firebase-config.js?v=4";
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  collection, collectionGroup, doc, setDoc, getDoc, getDocs, onSnapshot, updateDoc, query,
  orderBy, where, writeBatch, deleteDoc, addDoc, limit,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
  setPersistence, inMemoryPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const $ = (sel) => document.querySelector(sel);
const $all = (sel) => Array.from(document.querySelectorAll(sel));

const SUFIXO_LOGIN = "@pcm-alece.local";
function usuarioParaEmail(usuario) {
  return usuario.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "") + SUFIXO_LOGIN;
}
function extrairUsuario(email) {
  return String(email || "").split("@")[0];
}

const PRIORIDADE = {
  "1 - Presidência": 1, "2 - Primeiro Secretário": 2, "3 - Gabinetes": 3,
  "4 - TI/Racks": 4, "5 - Plenário": 5, "6 - Administração": 6, "7 - Todo o resto": 7,
};
const NOMES_DIAS = ["Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo"];
const STATUS_VALIDOS = ["Pendente", "Em andamento", "Concluída"];
const ROTULOS_PERMISSAO = { admin: "Administrador", padrao: "Padrão", trabalhador: "Trabalhador" };
const CHAVE_VERIFICACAO_ATRASADOS = "PMOCVerificacaoAtrasados";

const CHECKLIST_PREVENTIVA = [
  "Limpeza do filtro de ar",
  "Limpeza da serpentina evaporadora",
  "Limpeza da serpentina condensadora",
  "Verificação e limpeza do dreno de condensado",
  "Verificação da pressão do gás refrigerante",
  "Verificação de vazamentos",
  "Verificação das conexões e fiação elétrica",
  "Verificação da fixação/suportes da unidade",
  "Teste de funcionamento geral",
];

const MARCAS_CONDENSADORA = ["Midea", "Springer", "Carrier", "LG", "Komeco", "Philco", "Elgin", "Hitachi"];
const CAPACIDADES_CONDENSADORA = [
  "7.500 BTU/h", "9.000 BTU/h", "12.000 BTU/h", "18.000 BTU/h", "22.000 BTU/h",
  "24.000 BTU/h", "30.000 BTU/h", "32.000 BTU/h", "36.000 BTU/h", "48.000 BTU/h",
  "56.000 BTU/h", "60.000 BTU/h",
];
const ESPESSURAS_FIO = ["2.5mm", "4mm", "6mm"];
const MODELOS_EVAPORADORA = ["Split Hi-Wall", "Split Inverter", "Cassete", "Piso-Teto"];
const MESES_CICLO = 4;

async function calcularProximaData(item) {
  const local = item.local || "SEDE";
  const cap = (ESTADO.config?.capacidades || {})[local] || { nEquipes: 1, aparelhosDia: 2 };
  const capacidadeDia = Math.max(1, cap.nEquipes) * Math.max(1, cap.aparelhosDia);
  const diasSemana = (ESTADO.config && ESTADO.config.diasSemana) || 5;
  const DIAS_UTEIS = NOMES_DIAS.slice(0, diasSemana);
  const ehDiaUtilLocal = (dt) => DIAS_UTEIS.includes(NOMES_DIAS[(dt.getDay() + 6) % 7]) && !estaEmFeriado(dt);

  const [a, m, d] = item.dataAgendada.split("-");
  let cursor = adicionarMeses(new Date(a, parseInt(m, 10) - 1, d, 12, 0, 0), ESTADO.configSite.mesesCiclo);
  while (!ehDiaUtilLocal(cursor)) cursor.setDate(cursor.getDate() + 1);

  // Conta quantos outros aparelhos do mesmo prédio já têm a próxima
  // preventiva marcada nesse dia, pra não estourar a capacidade.
  const contarNoDia = (iso) =>
    ESTADO.equipamentos.filter((e) => e.id !== item.id && (e.local || "SEDE") === local && e.proximaPreventiva === iso).length;

  while (!ehDiaUtilLocal(cursor) || contarNoDia(formatISO(cursor)) >= capacidadeDia) {
    cursor.setDate(cursor.getDate() + 1);
  }
  return { data: formatISO(cursor), dia: NOMES_DIAS[(cursor.getDay() + 6) % 7] };
}

function adicionarMeses(date, meses) {
  const d = new Date(date.getTime());
  const diaOriginal = d.getDate();
  d.setMonth(d.getMonth() + meses);
  if (d.getDate() !== diaOriginal) d.setDate(0);
  return d;
}
let idEquipamentoEmEdicao = null;

function identificarSetor(setorTxt, ambienteTxt) {
  const texto = `${setorTxt || ""} ${ambienteTxt || ""}`.toUpperCase();
  if (/PRESID/.test(texto)) return "1 - Presidência";
  if (/1[ºªA]?\s*SECRETARIA|SECRETARI[OA]/.test(texto)) return "2 - Primeiro Secretário";
  if (/\bGABINETE\b/.test(texto)) return "3 - Gabinetes";
  if (/\bSERVIDOR\b|\bREDE\b|INFRAESTRUTURA|\bRACK\b|\bCPD\b|DESENVOLVIMENTO/.test(texto)) return "4 - TI/Racks";
  if (/PLEN[ÁA]RIO/.test(texto)) return "5 - Plenário";
  if (/PROTOCOLO|REPROGRAFIA|ADMINISTR/.test(texto)) return "6 - Administração";
  return "7 - Todo o resto";
}

function descobrirPiso(setorTxt) {
  if (!setorTxt) return 99;
  const texto = String(setorTxt).toUpperCase();
  if (texto.includes("SUBSOLO") || texto.includes("TÉRREO") || texto.includes("TERREO")) return 0;
  const m = texto.match(/(\d+)\s*[ºÂ°]?\s*PISO/);
  if (m) return parseInt(m[1], 10);
  return 99;
}

function normalizarStatus(valor) {
  const t = String(valor || "").trim().toUpperCase();
  if (t.includes("CONCL")) return "Concluída";
  if (t.includes("ANDAMENTO") || t.includes("EXECU")) return "Em andamento";
  return "Pendente";
}

function localizarColuna(nomesPossiveis, headers) {
  const lower = headers.map((h) => h.trim().toLowerCase());
  for (const nome of nomesPossiveis) {
    const idx = lower.indexOf(nome.toLowerCase());
    if (idx !== -1) return headers[idx];
  }
  for (const h of headers) {
    for (const nome of nomesPossiveis) {
      if (h.toUpperCase().includes(nome.toUpperCase())) return h;
    }
  }
  return null;
}

function formatISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function formatarDataBR(iso) {
  if (!iso) return "-";
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}
// Um aparelho é considerado atrasado quando a data agendada já passou e ele ainda não foi marcado como Concluída.
function estaAtrasado(item) {
  if (!item.dataAgendada || item.statusPreventiva === "Concluída") return false;
  return item.dataAgendada < formatISO(new Date());
}

const ESTADO = {
  meta: null,
  itensCarregados: [],
  equipamentos: [],
  feriados: [],
  ordens: [],
  auditoria: [],
  historico: [],
  chamadosCorretivos: [],
  usuarioNome: null,
  permissao: "padrao",
configSite: { mesesCiclo: MESES_CICLO, urlCorretivas: "", predios: ["SEDE", "ANEXO 1", "ANEXO 2", "ANEXO 3", "ANEXO 4"] },
  selecaoEquipamentos: new Set(),
  selecaoHistorico: new Set(),
  equipes: [],
  selecaoOrdens: new Set(),
  usuarios: [],
  ordenacaoEquipamentos: null,
  chamadosCorretivosCarregadosEm: null,
  usuarioEmail: null,
  cicloAtual: null,
  ciclos: [],
  unsubscribeCiclos: null,
  fechandoCiclo: false,
  config: null,
  filtros: { equipamentos: "", feriados: "", ordens: "", historico: "" },
  unsubscribe: null,
  unsubscribeFeriados: null,
  unsubscribeOrdens: null,
  unsubscribeHistorico: null,
  calYear: null,
  calMonth: null,
  diaSelecionado: null,
  localFiltro: "Todos",
  diasVaziosCronograma: [],
};
const URL_CHAMADOS_CORRETIVOS = "https://docs.google.com/spreadsheets/d/e/2PACX-1vR2Ysf9JofZL_2Xn_JPJFaPrMX6IGiwMQWFyhgJcqu8BK_4imC_lmrMgfpDWLnI6MIdcC0OYSDUQFPw/pub?gid=1978174237&single=true&output=csv";
ESTADO.configSite.urlCorretivas = URL_CHAMADOS_CORRETIVOS;
const INTERVALO_ATUALIZACAO_CORRETIVOS_MS = 5 * 60 * 1000; 

const COL_CORRETIVA = {
  DATA: 0, EQUIPE: 1, CHAMADO: 2, ANEXO: 4,
  GABINETE: 6, SALA: 7, NOME_SETOR: 8, SALA_SETOR: 9,
  TOMBO: 12, TAG: 13,
  SEDE: 23, ANEXO1: 24, ANEXO2: 25, ANEXO3: 26, ANEXO4: 27,
  SOLUCIONADO: 28, DESCRICAO_PROBLEMA: 29, PECA_FALTANTE: 30,
};

function converterDataCorretiva(valor) {
  if (typeof valor === "number") {
    const ms = Math.round((valor - 25569) * 86400 * 1000);
    return new Date(ms);
  }
  if (typeof valor === "string" && valor.trim()) {
    const m = valor.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})[ ,]*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (m) {
      const [, d, mo, y, h, mi, s] = m;
      return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s || 0));
    }
  }
  return null;
}

function formatarDataHoraCorretiva(dataObj) {
  if (!dataObj) return "-";
  const dia = String(dataObj.getDate()).padStart(2, "0");
  const mes = String(dataObj.getMonth() + 1).padStart(2, "0");
  const ano = dataObj.getFullYear();
  const hora = String(dataObj.getHours()).padStart(2, "0");
  const min = String(dataObj.getMinutes()).padStart(2, "0");
  return `${dia}/${mes}/${ano} ${hora}:${min}`;
}

async function carregarChamadosCorretivos(forcar) {
  const agora = Date.now();
  if (!forcar && ESTADO.chamadosCorretivosCarregadosEm &&
      (agora - ESTADO.chamadosCorretivosCarregadosEm) < INTERVALO_ATUALIZACAO_CORRETIVOS_MS) {
    return;
  }
  try {
    const resp = await fetch(ESTADO.configSite.urlCorretivas || URL_CHAMADOS_CORRETIVOS, { cache: "no-store" });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const texto = await resp.text();
    const wb = XLSX.read(texto, { type: "string" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const linhas = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    const dados = linhas.slice(1);

    ESTADO.chamadosCorretivos = dados.map((linha) => {
      const localAdicional = [linha[COL_CORRETIVA.SEDE], linha[COL_CORRETIVA.ANEXO1],
        linha[COL_CORRETIVA.ANEXO2], linha[COL_CORRETIVA.ANEXO3], linha[COL_CORRETIVA.ANEXO4]]
        .find((v) => String(v || "").trim()) || "";
      const dataObj = converterDataCorretiva(linha[COL_CORRETIVA.DATA]);
      return {
        data: dataObj ? dataObj.toISOString() : "", // formato que ordena certo
        dataFormatada: formatarDataHoraCorretiva(dataObj), // formato que aparece na tela
        equipe: linha[COL_CORRETIVA.EQUIPE] || "",
        chamado: linha[COL_CORRETIVA.CHAMADO] || "",
        anexo: String(linha[COL_CORRETIVA.ANEXO] || "").trim(),
        gabinete: linha[COL_CORRETIVA.GABINETE] || "",
        sala: linha[COL_CORRETIVA.SALA] || "",
        nomeSetor: linha[COL_CORRETIVA.NOME_SETOR] || "",
        salaSetor: linha[COL_CORRETIVA.SALA_SETOR] || "",
        localAdicional,
        tombo: String(linha[COL_CORRETIVA.TOMBO] || "").trim(),
        tag: String(linha[COL_CORRETIVA.TAG] || "").trim(),
        solucionado: linha[COL_CORRETIVA.SOLUCIONADO] || "",
        descricaoProblema: linha[COL_CORRETIVA.DESCRICAO_PROBLEMA] || "",
        pecaFaltante: linha[COL_CORRETIVA.PECA_FALTANTE] || "",
      };
    });
    ESTADO.chamadosCorretivosCarregadosEm = agora;
    renderEquipamentosCadastro();
  } catch (err) {
    console.error("Erro ao carregar chamados corretivos:", err);
  }
}

function normalizarTexto(v) {
  return String(v || "").trim().toUpperCase();
}

function chamadosDoEquipamento(item) {
  const patrimonio = normalizarTexto(item.patrimonio);
  const localItem = normalizarTexto(item.local);
  const setorAmbiente = normalizarTexto(`${item.setor} ${item.ambiente}`);
  const exatos = [];
  const aproximados = [];

  ESTADO.chamadosCorretivos.forEach((c) => {
    const tomboTag = normalizarTexto(c.tombo) || normalizarTexto(c.tag);
    if (patrimonio && tomboTag && tomboTag === patrimonio) {
      exatos.push(c);
      return;
    }
    const anexoChamado = normalizarTexto(c.anexo);
    if (localItem && anexoChamado && (anexoChamado === localItem || localItem.includes(anexoChamado) || anexoChamado.includes(localItem))) {
      const poolLocal = normalizarTexto(`${c.gabinete} ${c.sala} ${c.nomeSetor} ${c.salaSetor} ${c.localAdicional}`);
      // Só compara pelos NÚMEROS de sala/gabinete (ignorando o andar, que é 1
      // dígito) — palavras genéricas tipo "sala"/"gabinete"/"assessores"
      // aparecem em quase todo chamado do prédio e geravam falso positivo.
      const numerosItem = (setorAmbiente.match(/[0-9]+/g) || []).filter((n) => n.length >= 2);
      const numerosChamado = poolLocal.match(/[0-9]+/g) || [];
      if (numerosItem.length && numerosItem.some((n) => numerosChamado.includes(n))) {
        aproximados.push(c);
      }
    }
  });

  const porData = (a, b) => String(b.data).localeCompare(String(a.data));
  return { exatos: exatos.sort(porData), aproximados: aproximados.sort(porData) };
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2600);
}

$all(".subtab").forEach((btn) => {
  btn.addEventListener("click", () => {
    $all(".subtab").forEach((b) => b.classList.remove("active"));
    $all(".subview").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    $(`#subview-${btn.dataset.subview}`).classList.add("active");
    if (btn.dataset.subview === "cfg-usuarios") renderUsuarios();
    if (btn.dataset.subview === "cfg-auditoria") renderAuditoria();
    if (btn.dataset.subview === "cfg-geral") preencherFormularioConfigSite();
    if (btn.dataset.subview === "cfg-equipes") renderEquipesPorPredio();
  });
});

$all(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    $all(".tab").forEach((b) => b.classList.remove("active"));
    $all(".view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    $(`#view-${btn.dataset.view}`).classList.add("active");
    if (btn.dataset.view) {
      localStorage.setItem("ultimaAbaPMOC", btn.dataset.view);
    }
    if (btn.dataset.view === "calendar") renderCalendar();
    if (btn.dataset.view === "ciclos") renderCiclos();
    if (btn.dataset.view === "dashboard") renderDashboard();
    if (btn.dataset.view === "equipamentos") renderEquipamentosCadastro();
    if (btn.dataset.view === "feriados") renderFeriados();
    if (btn.dataset.view === "ordens") renderOrdens();
    if (btn.dataset.view === "historico") renderHistorico();
    if (btn.dataset.view === "config") renderCapacidadesPorPredio();
    if (btn.dataset.view === "auditoria") renderAuditoria();
    if (btn.dataset.view === "config-site") preencherFormularioConfigSite();
  });
});

function irParaAba(nome) {
  $(`.tab[data-view="${nome}"]`)?.click();
}
$("#navConfigSite")?.addEventListener("click", () => {
  $all(".tab").forEach((b) => b.classList.remove("active"));
  $all(".view").forEach((v) => v.classList.remove("active"));
  $("#view-config-site").classList.add("active");
  preencherFormularioConfigSite();
});

// ------------------------------------------------------------------
// Filtro por prédio (SEDE / Anexo 1 / Anexo 2 / ...) — usado nas telas
// que listam equipamentos, ordens e histórico.
// ------------------------------------------------------------------
function locaisDisponiveis() {
  const set = new Set(ESTADO.equipamentos.map((e) => e.local || "SEDE"));
  return ["Todos", ...[...set].sort()];
}

function aplicarFiltroLocal(itens) {
  if (ESTADO.localFiltro === "Todos") return itens;
  return itens.filter((i) => (i.local || "SEDE") === ESTADO.localFiltro);
}

function renderSeletorLocal(containerId) {
  const el = $(`#${containerId}`);
  if (!el) return;
  const locais = locaisDisponiveis();
  el.innerHTML = locais.map((l) =>
    `<button class="local-pill ${l === ESTADO.localFiltro ? "active" : ""}" data-local="${l}">${l}</button>`
  ).join("");
  el.querySelectorAll(".local-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      ESTADO.localFiltro = btn.dataset.local;

      // Pula o calendário para o primeiro mês com itens desse prédio, senão
      // o mês visível pode ficar "vazio" só porque o filtro mudou.
      const itensFiltrados = aplicarFiltroLocal(ESTADO.equipamentos).filter((i) => i.dataAgendada);
      if (itensFiltrados.length) {
        const ordenado = [...itensFiltrados].sort((a, b) => a.dataAgendada.localeCompare(b.dataAgendada));
        const primeira = new Date(ordenado[0].dataAgendada + "T12:00:00Z");
        ESTADO.calYear = primeira.getFullYear();
        ESTADO.calMonth = primeira.getMonth();
      }

      renderTodosSeletoresLocal();
      renderCalendar();
      renderDashboard();
      renderEquipamentosCadastro();
      renderOrdens();
      renderHistorico();

      // O painel de "dia selecionado" não escuta o filtro sozinho — se
      // tiver um dia aberto, teria que atualizar ele também, senão fica
      // mostrando os itens do prédio antigo até a pessoa clicar de novo.
      if (ESTADO.diaSelecionado) selecionarDia(ESTADO.diaSelecionado);
    });
  });
}

function renderTodosSeletoresLocal() {
  renderSeletorLocal("localFiltroCalendario");
  renderSeletorLocal("localFiltroDashboard");
  renderSeletorLocal("localFiltroOrdens");
  renderSeletorLocal("localFiltroHistorico");
  renderSeletorLocal("localFiltroEquipamentos");
}

// ------------------------------------------------------------------
// Faixa de alerta de atrasados (visível em qualquer aba)
// ------------------------------------------------------------------
const btnFecharAlertaAtrasados = $("#fecharAlertaAtrasados");
if (btnFecharAlertaAtrasados) {
  btnFecharAlertaAtrasados.addEventListener("click", () => {
    const banner = $("#alertaAtrasados");
    if (banner) {
      banner.dataset.fechado = formatISO(new Date());
    }
    atualizarBannerAtrasados();
  });
}

function atualizarBannerAtrasados() {
  const banner = $("#alertaAtrasados");
  const btnCal = $("#btnReagendarCalendario");
  if (!banner) return;

  const atrasados = ESTADO.equipamentos.filter(estaAtrasado);

  if (!atrasados.length) {
    banner.hidden = true;
    if (btnCal) btnCal.hidden = true;
    return;
  }

  const jaFechadoHoje = banner.dataset.fechado === formatISO(new Date());

  if (jaFechadoHoje) {
    // Aviso já foi fechado no X hoje — some o aviso, mas deixa a opção
    // acessível no calendário (só pra admin — reagendar é uma ação de
    // escrita, e esse botão não era coberto pelo travamento visual do
    // modo padrão/trabalhador por não ser um .btn.primary).
    banner.hidden = true;
    if (btnCal) btnCal.hidden = ESTADO.permissao !== "admin";
    return;
  }

  // Ainda não foi fechado — mostra o aviso normalmente, esconde o botão do
  // calendário (redundante enquanto o aviso já está visível).
  const txt = $("#alertaAtrasadosTexto");
  if (txt) {
    txt.textContent = atrasados.length === 1
      ? "1 aparelho está atrasado."
      : `${atrasados.length} aparelhos estão atrasados.`;
  }
  banner.hidden = false;
  if (btnCal) btnCal.hidden = true;
}
// ------------------------------------------------------------------
// Aviso de dias vazios no cronograma (aparece só na aba Calendário)
// ------------------------------------------------------------------
function atualizarAlertaDiasVazios() {
  const banner = $("#alertaDiasVazios");
  if (!banner) return;

  const diasVazios = ESTADO.diasVaziosCronograma || [];
  if (!diasVazios.length) {
    banner.hidden = true;
    return;
  }

  const txt = $("#alertaDiasVaziosTexto");
  if (txt) {
    txt.textContent = diasVazios.length === 1
      ? "1 dia útil ficou sem nada agendado (provavelmente por causa de um feriado)."
      : `${diasVazios.length} dias úteis ficaram sem nada agendado (provavelmente por causa de feriados).`;
  }
  banner.hidden = false;
}

$("#fecharAlertaDiasVazios")?.addEventListener("click", () => {
  const banner = $("#alertaDiasVazios");
  if (banner) banner.hidden = true;
});

$("#btnAdiantarDiasVazios")?.addEventListener("click", async () => {
  const btn = $("#btnAdiantarDiasVazios");
  btn.disabled = true;
  try {
    await adiantarDiasVazios();
    toast("Cronograma reorganizado para preencher os dias vazios.");
  } catch (err) {
    console.error(err);
    toast("Erro ao reorganizar o cronograma: " + err.message);
  } finally {
    btn.disabled = false;
  }
});

async function adiantarDiasVazios() {
  const itens = ESTADO.equipamentos.filter((e) =>
    e.statusPreventiva !== "Concluída" && e.fixadoManualmente !== true
  );
  if (!itens.length) return;

  compactarCronograma(itens);

  const TAMANHO_LOTE = 200;
  for (let inicio = 0; inicio < itens.length; inicio += TAMANHO_LOTE) {
    const pedaco = itens.slice(inicio, inicio + TAMANHO_LOTE);
    const batch = writeBatch(db);
    pedaco.forEach((item) => {
      batch.update(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", item.id), {
        dataAgendada: item.dataAgendada,
        diaPlanejado: item.diaPlanejado,
        semanaPlanejada: item.semanaPlanejada,
        ordemExecucao: item.ordemExecucao,
      });
    });
    await batch.commit();
  }

  ESTADO.diasVaziosCronograma = [];
  atualizarAlertaDiasVazios();
}

function jaVerificouAtrasadosHoje() {
  try {
    return localStorage.getItem(CHAVE_VERIFICACAO_ATRASADOS) === formatISO(new Date());
  } catch (e) {
    return false;
  }
}

function marcarVerificacaoAtrasadosHoje() {
  try {
    localStorage.setItem(CHAVE_VERIFICACAO_ATRASADOS, formatISO(new Date()));
  } catch (e) {
    // localStorage indisponível (modo privado etc.) — tudo bem, só não terá o cache diário
  }
}


const dropzone = $("#dropzone");
const fileInput = $("#fileInput");

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("dragover"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  if (e.dataTransfer.files[0]) processarArquivo(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) processarArquivo(fileInput.files[0]);
});

function processarArquivo(file) {
  $("#dropzoneLabel").textContent = `Lendo "${file.name}"...`;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, { type: "array" });
      let todasAsLinhas = [];
      wb.SheetNames.forEach((nomeAba) => {
        const sheet = wb.Sheets[nomeAba];
        const linhas = XLSX.utils.sheet_to_json(sheet, { defval: "" });
        linhas.forEach((linha) => { linha.__local = nomeAba.trim(); });
        todasAsLinhas = todasAsLinhas.concat(linhas);
      });

      if (!todasAsLinhas.length) throw new Error("Planilha vazia.");

      // --- O PULO DO GATO ---
      // 1. Limpamos o estado atual para não mostrar dados velhos
      ESTADO.equipamentos = []; 
      ESTADO.ordens = [];
      ESTADO.historico = [];
      
      // 2. Classificamos os novos dados
      classificar(todasAsLinhas);

      // 3. Forçamos a atualização da UI (Dashboard e Calendar vão ficar vazios ou prontos para o novo ciclo)
      renderDashboard();
      renderCalendar();

      $("#dropzoneLabel").textContent = `"${file.name}" carregado — ${todasAsLinhas.length} itens.`;

      toast("Planilha carregada! Configure o cronograma.");
      irParaAba("config");

    } catch (err) {
      toast("Erro ao ler o arquivo: " + err.message);
      $("#dropzoneLabel").textContent = "Clique ou arraste o arquivo aqui";
    }
  };
  reader.readAsArrayBuffer(file);
}

function classificar(rows) {
  const headers = Object.keys(rows[0]).map((h) => h.trim());
  const colSetor = localizarColuna(["Setor"], headers);
  const colAmbiente = localizarColuna(["Ambiente"], headers);
  const colStatus = localizarColuna(["Status / ano", "Status"], headers);
  const colPatrimonio = localizarColuna(["Patrimônio", "Patrimonio"], headers);
  
  // Novas colunas ensinadas ao sistema
  const colMarca = localizarColuna(["Marca"], headers);
  const colModelo = localizarColuna(["Modelo"], headers);
  const colPotencia = localizarColuna(["Potência", "BTU", "Capacidade"], headers);

  if (!colSetor || !colAmbiente) {
    toast("Não encontrei as colunas 'Setor' e 'Ambiente'. Confira o cabeçalho.");
    return;
  }
  ESTADO.meta = { colSetor, colAmbiente, colStatus, colPatrimonio };
  let ultimoSetor = "";
  let localAnterior = null;
  let linhasCorrigidas = 0;
  rows.forEach((row) => {
    if (row.__local !== localAnterior) {
      ultimoSetor = "";
      localAnterior = row.__local;
    }
    const valorAtual = String(row[colSetor] ?? "").trim();
    if (valorAtual) {
      ultimoSetor = valorAtual;
    } else if (ultimoSetor) {
      row[colSetor] = ultimoSetor;
      linhasCorrigidas++;
    }
  });
  if (linhasCorrigidas > 0) {
    console.log(`${linhasCorrigidas} linha(s) tinham Setor em branco (célula mesclada) e foram corrigidas.`);
  }

  // Conta quantas vezes cada patrimônio já apareceu nesta planilha, pra
  // desempatar duplicatas reais sem depender da posição da linha — assim
  // o ID de cada máquina fica estável entre reimportações (o que muda é
  // só o próprio número de patrimônio), e os dados técnicos já
  // preenchidos (infoCondensadoras) não se desconectam da máquina só
  // porque uma linha foi inserida/removida em outro lugar da planilha.
  const contagemPorPatrimonio = {};

  const itens = rows.map((row, idx) => {
    const setor = row[colSetor];
    const ambiente = row[colAmbiente];

    // Limpador de valores (Transforma "X" e "-" em vazio)
    const limparValor = (v) => {
      const str = String(v || "").trim();
      if (str === "-" || str.toUpperCase() === "X" || str.toUpperCase() === "N/A" || str === "") return "";
      return str;
    };

    const patrimonio = colPatrimonio ? limparValor(row[colPatrimonio]) : "";
    const marca = colMarca ? limparValor(row[colMarca]) : "";
    const modelo = colModelo ? limparValor(row[colModelo]) : "";

    let capacidade = colPotencia ? limparValor(row[colPotencia]) : "";
    if (capacidade && !capacidade.toLowerCase().includes("btu")) capacidade += " BTU/h";

    const setorPCM = identificarSetor(setor, ambiente);

    let id;
    if (patrimonio) {
      const base = patrimonio.replace(/[\s/\\"']/g, "_");
      contagemPorPatrimonio[base] = (contagemPorPatrimonio[base] || 0) + 1;
      id = contagemPorPatrimonio[base] > 1 ? `${base}_${contagemPorPatrimonio[base]}` : base;
    } else {
      id = `item_${idx}`;
    }

    return {
      id,
      patrimonio,
      marca,          // <--- Salva no Firebase
      modelo,         // <--- Salva no Firebase
      capacidade,     // <--- Salva no Firebase
      setor, ambiente,
      local: row.__local || "SEDE",
      statusCondicao: colStatus ? row[colStatus] : "",
      setorPCM,
      prioridadeSetor: PRIORIDADE[setorPCM] || 7,
      pisoPCM: descobrirPiso(setor),
      statusPreventiva: "Pendente",
      observacao: "",
    };
  });

  itens.sort((a, b) =>
    a.prioridadeSetor - b.prioridadeSetor ||
    a.pisoPCM - b.pisoPCM ||
    String(a.ambiente).localeCompare(String(b.ambiente)) ||
    String(a.patrimonio).localeCompare(String(b.patrimonio))
  );

  ESTADO.itensCarregados = itens;
  renderCapacidadesPorPredio();
  renderPreview(itens);
}

function renderPreview(itens) {
  const card = $("#previewCard");
  card.hidden = false;
  $("#previewCount").textContent = `${itens.length} itens`;
  const cols = [
    ["Patrimônio", (i) => i.patrimonio],
    ["Setor", (i) => i.setor],
    ["Ambiente", (i) => i.ambiente],
    ["Status", (i) => i.statusCondicao],
    ["Setor PCM", (i) => i.setorPCM],
    ["Piso", (i) => (i.pisoPCM === 99 ? "-" : i.pisoPCM)],
  ];
  const table = $("#previewTable");
  table.innerHTML = `<thead><tr>${cols.map((c) => `<th>${c[0]}</th>`).join("")}</tr></thead>
    <tbody>${itens.map((i) => `<tr>${cols.map((c) => `<td>${c[1](i) ?? ""}</td>`).join("")}</tr>`).join("")}</tbody>`;
}

$("#btnGerar").addEventListener("click", gerarCronograma);

function estaEmFeriado(date) {
  if (!date || !ESTADO.feriados || ESTADO.feriados.length === 0) return false;
  const iso = formatISO(date);
  return ESTADO.feriados.some((f) => f.dataInicio && f.dataFim && iso >= f.dataInicio && iso <= f.dataFim);
}

async function gerarCronograma() {
  if (!ESTADO.itensCarregados.length) {
    toast("Envie e classifique um levantamento primeiro.");
    irParaAba("upload");
    return;
  }

  const diasSemana = Math.min(7, Math.max(1, parseInt($("#diasSemana")?.value, 10) || 5));
  const dataInicioStr = $("#dataInicio")?.value;
  if (!dataInicioStr) {
    toast("Escolha a data de início do cronograma.");
    return;
  }
  const capacidades = lerCapacidadesDaTela();

  const DIAS_UTEIS = NOMES_DIAS.slice(0, diasSemana);
  function ehDiaUtil(data) {
    return DIAS_UTEIS.includes(NOMES_DIAS[(data.getDay() + 6) % 7]) && !estaEmFeriado(data);
  }

  const [anoI, mesI, diaI] = dataInicioStr.split("-");
  let dataInicioBase = new Date(anoI, parseInt(mesI, 10) - 1, diaI, 12, 0, 0);
  while (!ehDiaUtil(dataInicioBase)) dataInicioBase.setDate(dataInicioBase.getDate() + 1);
  const primeiraDataUtilGlobal = new Date(dataInicioBase);

  $("#btnGerar").disabled = true;
  try {
    // Captura os cadastros manuais e o status/observação de itens que já
    // existiam, ANTES de apagar tudo — assim nada se perde no reset.
    const existentes = {};
    const manuaisPreservados = [];
    ESTADO.equipamentos.forEach((dados) => {
      existentes[dados.id] = dados;
      if (dados.origem === "manual") manuaisPreservados.push({ ...dados });
    });

    toast("Apagando ciclos anteriores...");
    await registrarAuditoria("Gerar cronograma", `Novo levantamento com ${ESTADO.itensCarregados.length} itens (apagou ciclos anteriores)`);
    await apagarTodosOsCiclos();

    const cicloRef = doc(collection(db, "ciclos"));
    ESTADO.cicloAtual = cicloRef.id;
    await setDoc(cicloRef, {
        criadoEm: new Date().toISOString(),
        dataInicio: formatISO(primeiraDataUtilGlobal),
        status: "Ativo"
    });
    ESTADO.config = { diasSemana, dataInicio: formatISO(primeiraDataUtilGlobal), capacidades };
    await setDoc(doc(db, "config", "cronograma"), ESTADO.config);
    const itensPlanilha = ESTADO.itensCarregados.map((i) => ({ ...i }));
    toast("Salvando...");
    const itens = [...itensPlanilha, ...manuaisPreservados];

    // Agrupa por prédio — cada grupo anda no próprio ritmo, com sua própria capacidade
    const grupos = new Map();
    itens.forEach((item) => {
      const local = item.local || "SEDE";
      if (!grupos.has(local)) grupos.set(local, []);
      grupos.get(local).push(item);
    });

    const resumoPorPredio = [];

    grupos.forEach((itensDoPredio, local) => {
      const cap = capacidades[local] || { nEquipes: 1, aparelhosDia: 2 };
      const capacidadeDia = Math.max(1, cap.nEquipes) * Math.max(1, cap.aparelhosDia);

      let dataCursor = new Date(primeiraDataUtilGlobal);
      let contador = 0;
      let diasUteisAgendados = 0; // <--- A ROLETA QUE CONTA OS DIAS
      let grupoAmbienteAtual = null;
      let indiceGrupo = -1;
      let ordem = 0;

      itensDoPredio.forEach((item) => {
        const chaveAmbiente = `${item.setor}||${item.ambiente}`;
        if (chaveAmbiente !== grupoAmbienteAtual) {
          grupoAmbienteAtual = chaveAmbiente;
          indiceGrupo++;
        }

        // --- A MÁGICA DA ROLETA DIÁRIA ---
        const nVagas = cap.nEquipes || 1;
        const slotDaSala = indiceGrupo % nVagas; // Prende a equipe à Vaga do dia (0 ou 1)

        if (cap.modoRodizio && cap.equipesAtivas && cap.equipesAtivas.length > 0) {
            const pool = cap.equipesAtivas;
            // Avança no pool 1,2 -> 3,4 -> 5,6 conforme o dia muda
            const indiceNoPool = (diasUteisAgendados * nVagas + slotDaSala) % pool.length;
            item.equipeResponsavel = pool[indiceNoPool];
        } else {
            // Se o rodízio estiver desligado, usa o comportamento clássico
            const ordemEquipe = slotDaSala + 1;
            const encontrada = ESTADO.equipes.find((e) => e.predio === local && e.ordem === ordemEquipe);
            item.equipeResponsavel = encontrada ? encontrada.nome : `Equipe ${ordemEquipe}`;
        }
        // ---------------------------------

        ordem++;
        item.ordemExecucao = ordem;
        item.dataAgendada = formatISO(dataCursor);
        item.diaPlanejado = NOMES_DIAS[(dataCursor.getDay() + 6) % 7];
        const diffDias = Math.floor((dataCursor - primeiraDataUtilGlobal) / 86400000);
        item.semanaPlanejada = `Semana ${Math.floor(diffDias / 7) + 1}`;

        const anterior = existentes[item.id];
        if (anterior) {
          item.statusPreventiva = anterior.statusPreventiva || "Pendente";
          item.observacao = anterior.observacao || "";
        }

        contador++;
        if (contador >= capacidadeDia) {
          contador = 0;
          diasUteisAgendados++; // <--- O DIA ACABOU! A roleta gira para amanhã.
          do { dataCursor.setDate(dataCursor.getDate() + 1); } while (!ehDiaUtil(dataCursor));
        }
      });

      const diasNecessarios = Math.ceil(itensDoPredio.length / capacidadeDia);
      resumoPorPredio.push(`<strong>${local}</strong>: ${itensDoPredio.length} itens · ${diasNecessarios} dia(s) úteis · capacidade ${capacidadeDia}/dia`);
    });

    $("#resumoCapacidade").innerHTML = resumoPorPredio.join("<br>") +
      (manuaisPreservados.length ? `<br>${manuaisPreservados.length} cadastrado(s) manualmente incluído(s)` : "");

    const TAMANHO_LOTE = 400;

    for (let inicio = 0; inicio < itens.length; inicio += TAMANHO_LOTE) {
      const pedaco = itens.slice(inicio, inicio + TAMANHO_LOTE);
      const batch = writeBatch(db);
      pedaco.forEach((item) => batch.set(
          doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", item.id),
          item
      ));
      await batch.commit();
      toast(`Salvando... ${Math.min(inicio + TAMANHO_LOTE, itens.length)}/${itens.length}`);
    }

    iniciarSincronizacao();
    toast(`Cronograma gerado e salvo! (${itens.length} itens)`);
    irParaAba("calendar");
  } catch (err) {
    console.error(err);
    toast("Erro ao salvar no Firebase: " + err.message);
  } finally {
    $("#btnGerar").disabled = false;
  }
}

// Reorganiza as datas de TODOS os equipamentos já salvos, respeitando a ordem
// de execução, a capacidade diária e os feriados/férias atuais. É chamada
// automaticamente ao cadastrar um feriado novo ou um equipamento manual, para
// que o cronograma sempre reflita o estado mais recente sem precisar reimportar
// a planilha.
async function reagendarTudo(permitirRecuo = false) {
  if (!ESTADO.equipamentos.length) return;

  if (!ESTADO.config) {
    ESTADO.config = { diasSemana: 5, dataInicio: formatISO(new Date()), capacidades: {} };
  }
  if (!ESTADO.config.capacidades) ESTADO.config.capacidades = {};

  const { diasSemana, dataInicio, capacidades } = ESTADO.config;
  const DIAS_UTEIS = NOMES_DIAS.slice(0, diasSemana || 5);
  const hojeISO = formatISO(new Date());

  function ehDiaUtilLocal(data) {
    return DIAS_UTEIS.includes(NOMES_DIAS[(data.getDay() + 6) % 7]) && !estaEmFeriado(data);
  }

  const dataBaseStr = dataInicio > hojeISO ? dataInicio : hojeISO;
  const [anoB, mesB, diaB] = dataBaseStr.split("-");
  const dataCursorInicial = new Date(anoB, parseInt(mesB, 10) - 1, diaB, 12, 0, 0);
  while (!ehDiaUtilLocal(dataCursorInicial)) dataCursorInicial.setDate(dataCursorInicial.getDate() + 1);

  const [anoIn, mesIn, diaIn] = dataInicio.split("-");
  const primeiraDataUtil = new Date(anoIn, parseInt(mesIn, 10) - 1, diaIn, 12, 0, 0);
  while (!ehDiaUtilLocal(primeiraDataUtil)) primeiraDataUtil.setDate(primeiraDataUtil.getDate() + 1);

  const porPredio = new Map();
  ESTADO.equipamentos.forEach((e) => {
    const local = e.local || "SEDE";
    if (!porPredio.has(local)) porPredio.set(local, []);
    porPredio.get(local).push(e);
  });

  const atualizacoes = [];

  porPredio.forEach((itensDoPredio, local) => {
    const cap = capacidades[local] || { nEquipes: 1, aparelhosDia: 2 };
    const capacidadeDia = Math.max(1, cap.nEquipes) * Math.max(1, cap.aparelhosDia);

    const fixos = itensDoPredio.filter((e) =>
      e.statusPreventiva === "Concluída" ||
      (e.statusPreventiva === "Em andamento" && !estaAtrasado(e)) ||
      e.fixadoManualmente === true
    );
    const pendentes = itensDoPredio
      .filter((e) =>
        (e.statusPreventiva === "Pendente" || (e.statusPreventiva === "Em andamento" && estaAtrasado(e))) &&
        e.fixadoManualmente !== true // <--- A correção principal está aqui
      )
      .sort((a, b) => (a.ordemExecucao || 0) - (b.ordemExecucao || 0));

    const ocupacao = {};
    fixos.forEach((f) => {
      if (f.dataAgendada >= hojeISO) {
        ocupacao[f.dataAgendada] = (ocupacao[f.dataAgendada] || 0) + 1;
      }
    });

    let dataCursor = new Date(dataCursorInicial);

    pendentes.forEach((item) => {
      
      // Impede que o item seja puxado para trás — EXCETO quando quem chamou
      // pediu explicitamente pra permitir (caso de remover feriado, que deve
      // liberar a vaga pros aparelhos recuarem).
      if (!permitirRecuo && item.dataAgendada && item.dataAgendada > formatISO(dataCursor)) {
        const [aA, mA, dA] = item.dataAgendada.split("-");
        dataCursor = new Date(aA, parseInt(mA, 10) - 1, dA, 12, 0, 0);
      }

      // Continua com a lógica padrão: se o dia não for útil ou estiver cheio, empurra para frente.
      while (!ehDiaUtilLocal(dataCursor) || (ocupacao[formatISO(dataCursor)] || 0) >= capacidadeDia) {
        dataCursor.setDate(dataCursor.getDate() + 1);
      }
      
      const novaData = formatISO(dataCursor);
      const novoDia = NOMES_DIAS[(dataCursor.getDay() + 6) % 7];
      const diffDias = Math.floor((dataCursor - primeiraDataUtil) / 86400000);
      const novaSemana = `Semana ${Math.max(1, Math.floor(diffDias / 7) + 1)}`;

      ocupacao[novaData] = (ocupacao[novaData] || 0) + 1;

      if (item.dataAgendada !== novaData || item.diaPlanejado !== novoDia || item.semanaPlanejada !== novaSemana) {
        atualizacoes.push({
          id: item.id, dataAgendada: novaData, diaPlanejado: novoDia, semanaPlanejada: novaSemana,
          dataAntiga: item.dataAgendada, refCompleta: item,
        });
      }
    });
  });

  if (atualizacoes.length) {
    const TAMANHO_LOTE = 200;
    const agora = new Date().toISOString();

    for (let inicio = 0; inicio < atualizacoes.length; inicio += TAMANHO_LOTE) {
      const pedaco = atualizacoes.slice(inicio, inicio + TAMANHO_LOTE);
      const batch = writeBatch(db);
      pedaco.forEach((u) => {
        batch.update(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", u.id), {
          dataAgendada: u.dataAgendada, diaPlanejado: u.diaPlanejado, semanaPlanejada: u.semanaPlanejada,
        });
        if (u.dataAntiga && u.dataAntiga < hojeISO) {
          const novoLogRef = doc(collection(     db,     "ciclos",     ESTADO.cicloAtual,     "historico" ));
          batch.set(novoLogRef, {
            equipamentoId: u.refCompleta.id,
            patrimonio: u.refCompleta.patrimonio || "",
            setor: u.refCompleta.setor || "",
            ambiente: u.refCompleta.ambiente || "",
            local: u.refCompleta.local || "SEDE",
            equipe: u.refCompleta.equipeResponsavel || "",
            tipo: "Atraso Reagendado",
            dataAnterior: u.dataAntiga,
            dataNova: u.dataAgendada,
            registradoEm: agora,
          });
        }
      });
      await batch.commit();
    }
    toast(`Cronograma recalculado (${atualizacoes.length} item(ns) reagendado(s)).`);
  }

  await setDoc(doc(db, "config", "cronograma"), ESTADO.config);
}

async function carregarConfigSite() {
  try {
    const snap = await getDoc(doc(db, "config", "site"));
    if (snap.exists()) {
      const dados = snap.data();
      ESTADO.configSite = {
        mesesCiclo: dados.mesesCiclo || MESES_CICLO,
        urlCorretivas: dados.urlCorretivas || URL_CHAMADOS_CORRETIVOS,
        predios: (dados.predios && dados.predios.length) ? dados.predios : ["SEDE", "ANEXO 1", "ANEXO 2", "ANEXO 3", "ANEXO 4"],
      };
    }
    preencherFormularioConfigSite();
  } catch (err) {
    console.error("Erro ao carregar configurações:", err);
  }
}

function preencherFormularioConfigSite() {
  // Preenche os inputs do formulário (Modo Edição)
  if ($("#cfgMesesCiclo")) $("#cfgMesesCiclo").value = ESTADO.configSite.mesesCiclo;
  if ($("#cfgUrlCorretivas")) $("#cfgUrlCorretivas").value = ESTADO.configSite.urlCorretivas;
  if ($("#cfgPredios")) $("#cfgPredios").value = ESTADO.configSite.predios.join("\n");

  // Preenche os textos visuais (Modo Leitura)
  if ($("#txtCfgMeses")) $("#txtCfgMeses").textContent = ESTADO.configSite.mesesCiclo + " meses";
  if ($("#txtCfgUrl")) $("#txtCfgUrl").textContent = ESTADO.configSite.urlCorretivas || "Nenhum link configurado";
  if ($("#txtCfgPredios")) $("#txtCfgPredios").textContent = ESTADO.configSite.predios.join(" · ");

  // CORREÇÃO: Preenche automaticamente as opções de Prédio no cadastro de equipamentos
  const selectEqLocal = $("#eqLocal");
  if (selectEqLocal && ESTADO.configSite && ESTADO.configSite.predios) {
    selectEqLocal.innerHTML = ESTADO.configSite.predios.map(p => `<option value="${p}">${p}</option>`).join("");
  }
}

// --- CONTROLES DE MODO LEITURA/EDIÇÃO ---
$("#btnHabilitarEdicaoCfg")?.addEventListener("click", () => {
  $("#cfgModoLeitura").hidden = true;
  $("#btnHabilitarEdicaoCfg").hidden = true;
  $("#cfgModoEdicao").hidden = false;
});

$("#btnCancelarEdicaoCfg")?.addEventListener("click", () => {
  $("#cfgModoEdicao").hidden = true;
  $("#cfgModoLeitura").hidden = false;
  $("#btnHabilitarEdicaoCfg").hidden = false;
  preencherFormularioConfigSite(); // Volta os inputs pro valor original se a pessoa desistir
});

// Prédio é referenciado por nome (texto puro) em equipamentos.local,
// config.capacidades e equipes.predio — renomear/apagar na lista de
// prédios sem cascatear deixa tudo isso órfão silenciosamente.
async function propagarRenomeacaoPredios(renomeacoes) {
  for (const { antigo, novo } of renomeacoes) {
    const afetados = ESTADO.equipamentos.filter((e) => (e.local || "SEDE") === antigo);
    if (afetados.length && ESTADO.cicloAtual) {
      const TAMANHO_LOTE = 400;
      for (let inicio = 0; inicio < afetados.length; inicio += TAMANHO_LOTE) {
        const pedaco = afetados.slice(inicio, inicio + TAMANHO_LOTE);
        const batch = writeBatch(db);
        pedaco.forEach((item) => {
          batch.update(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", item.id), { local: novo });
        });
        await batch.commit();
      }
    }

    const equipesDoPredio = ESTADO.equipes.filter((e) => e.predio === antigo);
    if (equipesDoPredio.length) {
      const batch = writeBatch(db);
      equipesDoPredio.forEach((eq) => batch.update(doc(db, "equipes", eq.id), { predio: novo }));
      await batch.commit();
    }
  }

  const capacidadesAtuais = { ...((ESTADO.config && ESTADO.config.capacidades) || {}) };
  let capacidadesMudaram = false;
  for (const { antigo, novo } of renomeacoes) {
    if (capacidadesAtuais[antigo]) {
      capacidadesAtuais[novo] = capacidadesAtuais[antigo];
      delete capacidadesAtuais[antigo];
      capacidadesMudaram = true;
    }
  }
  if (capacidadesMudaram) {
    ESTADO.config = { ...(ESTADO.config || {}), capacidades: capacidadesAtuais };
    await setDoc(doc(db, "config", "cronograma"), ESTADO.config);
  }
}

// --- SALVAR CONFIGURAÇÕES ---
$("#btnSalvarConfigSite")?.addEventListener("click", async () => {
  const mesesCiclo = Math.max(1, parseInt($("#cfgMesesCiclo").value, 10) || 4);
  const urlCorretivas = $("#cfgUrlCorretivas").value.trim();
  const predios = $("#cfgPredios").value.split("\n").map((p) => p.trim()).filter(Boolean);

  if (!predios.length) {
    toast("Coloca pelo menos um prédio na lista.");
    return;
  }

  const prediosAntigos = ESTADO.configSite.predios || [];
  const removidos = prediosAntigos.filter((p) => !predios.includes(p));
  const adicionados = predios.filter((p) => !prediosAntigos.includes(p));

  let renomeacoes = [];
  if (removidos.length && removidos.length === adicionados.length) {
    renomeacoes = removidos.map((antigo, i) => ({ antigo, novo: adicionados[i] }));
    const descricao = renomeacoes.map((r) => `"${r.antigo}" → "${r.novo}"`).join(", ");
    const ok = window.confirm(
      `Parece que você renomeou: ${descricao}.\n\nQuer que eu atualize automaticamente os equipamentos, equipes e capacidades já cadastrados pra usar o nome novo? Se a lista mudou por outro motivo, clique em Cancelar (a lista de prédios salva do mesmo jeito, só não mexe em mais nada).`
    );
    if (!ok) renomeacoes = [];
  } else if (removidos.length) {
    const impacto = removidos
      .map((p) => `${p} (${ESTADO.equipamentos.filter((e) => (e.local || "SEDE") === p).length} equipamento(s))`)
      .join(", ");
    const temImpacto = removidos.some((p) => ESTADO.equipamentos.some((e) => (e.local || "SEDE") === p));
    if (temImpacto) {
      const ok = window.confirm(
        `Remover ${removidos.join(", ")} da lista vai deixar estes equipamentos sem prédio válido: ${impacto}.\n\nEles continuam existindo, mas somem dos filtros por prédio. Quer continuar mesmo assim?`
      );
      if (!ok) return;
    }
  }

  const novaConfig = { mesesCiclo, urlCorretivas, predios };
  try {
    await setDoc(doc(db, "config", "site"), novaConfig);
    ESTADO.configSite = novaConfig;

    if (renomeacoes.length) {
      await propagarRenomeacaoPredios(renomeacoes);
    }

    await registrarAuditoria("Alterar parâmetros do sistema", `Ciclo: ${mesesCiclo} meses`);
    toast("Configurações salvas com sucesso!");
    carregarChamadosCorretivos(true);

    // Sucesso! Volta para o Modo Leitura automaticamente
    $("#btnCancelarEdicaoCfg").click();

  } catch (err) {
    console.error(err);
    toast("Erro ao salvar: " + err.message);
  }

  const selectEqLocal = $("#eqLocal");
  if (selectEqLocal) {
    selectEqLocal.innerHTML = ESTADO.configSite.predios.map((p) => `<option value="${p}">${p}</option>`).join("");
  }
});

async function carregarConfig() {
  try {
    const snap = await getDoc(doc(db, "config", "cronograma"));
    if (snap.exists()) {
      ESTADO.config = snap.data();
      if ($("#nEquipes")) $("#nEquipes").value = ESTADO.config.nEquipes;
      if ($("#aparelhosDia")) $("#aparelhosDia").value = ESTADO.config.aparelhosDia;
      if ($("#diasSemana")) $("#diasSemana").value = ESTADO.config.diasSemana;
      if ($("#dataInicio")) $("#dataInicio").value = ESTADO.config.dataInicio;
        renderCapacidadesPorPredio();
    }
  } catch (err) {
    console.error(err);
  }
}
async function carregarCicloAtual() {

    const snap = await getDocs(
        query(
            collection(db, "ciclos"),
            orderBy("criadoEm", "desc"),
            limit(1)
        )
    );

    if (snap.empty) {
        ESTADO.cicloAtual = null;
        return;
    }

    ESTADO.cicloAtual = snap.docs[0].id;
}
function iniciarSincronizacao() {
  if (!ESTADO.cicloAtual) return;
  if (ESTADO.unsubscribe) ESTADO.unsubscribe();
  const q = query( collection(db, "ciclos", ESTADO.cicloAtual, "equipamentos"),orderBy("ordemExecucao")
);
  ESTADO.unsubscribe = onSnapshot(q, (snap) => {
    ESTADO.equipamentos = snap.docs.map((d) => d.data());
    if (!ESTADO.calYear && ESTADO.equipamentos.length) {
      const primeira = new Date(ESTADO.equipamentos[0].dataAgendada + "T12:00:00Z");
      ESTADO.calYear = primeira.getFullYear();
      ESTADO.calMonth = primeira.getMonth();
    }
    renderCalendar();
    renderDashboard();
    renderEquipamentosCadastro();
    atualizarBannerAtrasados();
    atualizarAlertaDiasVazios();
    renderCiclos();
    verificarFechamentoCiclo();
    renderTodosSeletoresLocal();
  }, (err) => {
    console.error(err);
    toast("Erro ao ler dados do Firebase: " + err.message);
  });
}

async function inicializarApp() {
    await carregarCicloAtual();
    carregarConfig();
    carregarChamadosCorretivos(true);
    setInterval(() => carregarChamadosCorretivos(), INTERVALO_ATUALIZACAO_CORRETIVOS_MS);
    iniciarSincronizacao();
    iniciarSincronizacaoHistorico();
    iniciarSincronizacaoOrdens();
    iniciarSincronizacaoCiclos();
}

let modoCadastro = false;

function mostrarErroAuth(msg) {
  const el = $("#authErro");
  if (el) el.textContent = msg;
}

$("#btnAuthCriarConta")?.addEventListener("click", () => {
  modoCadastro = !modoCadastro;
  $("#authTitulo").textContent = modoCadastro ? "Criar conta" : "Entrar";
  $("#btnAuthEntrar").textContent = modoCadastro ? "Criar conta" : "Entrar";
  $("#btnAuthCriarConta").textContent = modoCadastro ? "Já tenho conta, entrar" : "Criar uma conta nova";
  mostrarErroAuth("");
});

$("#btnAuthEntrar")?.addEventListener("click", async () => {
  const usuarioDigitado = $("#authEmail").value.trim();
  const senha = $("#authSenha").value;
  if (!usuarioDigitado || !senha) { mostrarErroAuth("Preencha usuário e senha."); return; }
  const email = usuarioParaEmail(usuarioDigitado);
  mostrarErroAuth("");
  try {
    if (modoCadastro) {
      await createUserWithEmailAndPassword(auth, email, senha);
    } else {
      await signInWithEmailAndPassword(auth, email, senha);
    }
  } catch (err) {
    console.error("Erro de autenticação:", err.code, err.message);
    const mensagens = {
      "auth/email-already-in-use": "Esse e-mail já tem conta. Clique em \"Já tenho conta\".",
      "auth/invalid-email": "E-mail inválido.",
      "auth/weak-password": "Senha muito curta (mínimo 6 caracteres).",
      "auth/user-not-found": "E-mail não encontrado.",
      "auth/wrong-password": "Senha incorreta.",
      "auth/invalid-credential": "E-mail ou senha incorretos.",
    };
    mostrarErroAuth(mensagens[err.code] || ("Erro: " + err.message));
  }
});

$("#btnSair")?.addEventListener("click", () => {
  
  // Desliga todos os "escutadores" do Firestore antes de sair — senão eles
  // continuam tentando sincronizar sem permissão e enchem o console de erro.
  if (ESTADO.unsubscribe) ESTADO.unsubscribe();
  if (ESTADO.unsubscribeFeriados) ESTADO.unsubscribeFeriados();
  if (ESTADO.unsubscribeOrdens) ESTADO.unsubscribeOrdens();
  if (ESTADO.unsubscribeHistorico) ESTADO.unsubscribeHistorico();
  if (ESTADO.unsubscribeCiclos) ESTADO.unsubscribeCiclos();
  appJaInicializado = false; // permite reiniciar tudo se logar de novo sem recarregar a página
  signOut(auth);
});

let appJaInicializado = false;
async function registrarUsuarioLogado(user) {
  const ref = doc(db, "usuarios", user.uid);
  const snap = await getDoc(ref);
  const agora = new Date().toISOString();
  if (!snap.exists()) {
    const dados = {
      usuario: extrairUsuario(user.email),
      permissao: "padrao",
      bloqueado: false,
      criadoEm: agora,
      ultimoLogin: agora,
    };
    await setDoc(ref, dados);
    return dados;
  }
  await updateDoc(ref, { ultimoLogin: agora });
  return snap.data();
}

onAuthStateChanged(auth, async (user) => {
  const overlay = $("#authOverlay");
  const appRoot = $("#appRoot");
  const telaCarregando = $("#telaCarregando");
  if (telaCarregando) telaCarregando.remove();
  if (user) {
    ESTADO.usuarioEmail = user.email;
    ESTADO.usuarioNome = extrairUsuario(user.email);
    try {
      const dadosUsuario = await registrarUsuarioLogado(user);
      if (dadosUsuario && dadosUsuario.bloqueado) {
        mostrarErroAuth("Sua conta está bloqueada. Fale com a administradora.");
        await signOut(auth);
        return;
      }
      ESTADO.permissao = (dadosUsuario && dadosUsuario.permissao) || "padrao";
    } catch (err) {
      console.error("Erro ao verificar usuário:", err);
    }
    if (overlay) overlay.hidden = true;
    if (appRoot) appRoot.hidden = false;
    atualizarVisibilidadeAdmin();
    if (!appJaInicializado) {
          appJaInicializado = true;
          inicializarApp();
          if (ESTADO.permissao === "admin") { iniciarSincronizacaoUsuarios(); iniciarSincronizacaoAuditoria(); iniciarSincronizacaoEquipes(); }
          await carregarConfigSite();
          const abaSalva = localStorage.getItem("ultimaAbaPMOC") || "dashboard";
          irParaAba(abaPermitida(abaSalva, ESTADO.permissao) ? abaSalva : "dashboard");
        }
  } else {
    if (overlay) overlay.hidden = false;
    if (appRoot) appRoot.hidden = true;
  }
});

function atualizarVisibilidadeAdmin() {
  const permissao = ESTADO.permissao;
  const isAdmin = permissao === "admin";
  const isTrabalhador = permissao === "trabalhador";

  const btnCfg = $("#navConfigSite");
  if (btnCfg) btnCfg.hidden = !isAdmin;

  // Trabalhador herda o mesmo travamento visual do padrão (não edita nada
  // fora do previsto), mas com uma exceção: o status do calendário e o
  // formulário de concluir preventiva continuam interativos (ver CSS).
  document.body.classList.toggle("modo-padrao", permissao === "padrao" || isTrabalhador);
  document.body.classList.toggle("modo-trabalhador", isTrabalhador);

  // Levantamento e Cronograma só pra admin
  ["upload", "config"].forEach((view) => {
    const tab = $(`.tab[data-view="${view}"]`);
    if (tab) tab.hidden = !isAdmin;
  });

  // Trabalhador só vê Calendário e Dashboard — some com o resto do menu
  ["ordens", "historico", "equipamentos", "feriados"].forEach((view) => {
    const tab = $(`.tab[data-view="${view}"]`);
    if (tab) tab.hidden = isTrabalhador;
  });
}

function abaPermitida(nome, permissao) {
  if (permissao === "admin") return true;
  if (["upload", "config"].includes(nome)) return false;
  if (permissao === "trabalhador" && ["ordens", "historico", "equipamentos", "feriados"].includes(nome)) return false;
  return true;
}


// ------------------------------------------------------------------
// Administração de usuários (só visível/funcional para permissao=="admin";
// a trava de verdade está nas regras do Firestore, não só aqui)
// ------------------------------------------------------------------
async function criarContaAdmin(usuario, senha, permissao) {
  const nomeAppTemp = "temp_" + Date.now();
  const appTemp = initializeApp(firebaseConfig, nomeAppTemp);
  const authTemp = getAuth(appTemp);

  try {
    await setPersistence(authTemp, inMemoryPersistence);

    const email = usuarioParaEmail(usuario);
    const cred = await createUserWithEmailAndPassword(authTemp, email, senha);
    const uid = cred.user.uid;

    await signOut(authTemp);

    await setDoc(doc(db, "usuarios", uid), {
      usuario: usuario.trim().toLowerCase(),
      permissao,
      bloqueado: false,
      criadoEm: new Date().toISOString(),
      ultimoLogin: "",
      criadoPor: ESTADO.usuarioNome || "",
    });
    await registrarAuditoria("Criar usuário", `${usuario} (${permissao})`);
  } finally {
    await deleteApp(appTemp);
  }
}

$("#btnCriarUsuario")?.addEventListener("click", async () => {
  const usuario = $("#novoUsuarioNome").value.trim();
  const senha = $("#novoUsuarioSenha").value;
  const permissao = $("#novoUsuarioPermissao").value;

  if (!usuario || senha.length < 6) {
    toast("Preencha o usuário e uma senha com 6 ou mais caracteres.");
    return;
  }

  // Muda o botão para mostrar que está carregando
  const btn = $("#btnCriarUsuario");
  btn.disabled = true;
  btn.textContent = "Criando...";

  try {
    await criarContaAdmin(usuario, senha, permissao);
    toast(`Conta "${usuario}" criada com sucesso!`);

    // Limpa os campos
    $("#novoUsuarioNome").value = "";
    $("#novoUsuarioSenha").value = "";

    // FORÇA O SISTEMA A RECARREGAR A TABELA NA MESMA HORA
    iniciarSincronizacaoUsuarios();
    
  } catch (err) {
    console.error(err);
    const msgs = {
      "auth/email-already-in-use": "Esse nome de usuário já existe.",
      "auth/weak-password": "Senha muito curta.",
    };
    toast(msgs[err.code] || ("Erro: " + err.message));
  } finally {
    // Volta o botão ao normal
    btn.disabled = false;
    btn.textContent = "+ Criar conta";
  }
});

function iniciarSincronizacaoUsuarios() {
  const q = query(collection(db, "usuarios"), orderBy("criadoEm", "desc"));
  onSnapshot(q, (snap) => {
    ESTADO.usuarios = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderUsuarios();
  }, (err) => console.error("Erro ao ler usuários:", err));
}

function iniciarSincronizacaoAuditoria() {
  const q = query(collection(db, "auditoria"), orderBy("registradoEm", "desc"), limit(500));
  onSnapshot(q, (snap) => {
    ESTADO.auditoria = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAuditoria();
  }, (err) => console.error("Erro ao ler auditoria:", err));
}

function renderAuditoria() {
  const table = $("#auditoriaTable");
  if (!table) return;
  const registros = ESTADO.auditoria || [];
  $("#auditoriaCount").textContent = `${registros.length} registros`;
  table.innerHTML = `<thead><tr>
      <th>Data/Hora</th><th>Usuário</th><th>Ação</th><th>Detalhes</th>
    </tr></thead><tbody></tbody>`;
  const tbody = table.querySelector("tbody");
  registros.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${new Date(r.registradoEm).toLocaleString("pt-BR")}</td>
      <td>${r.usuario || "-"}</td>
      <td><strong>${r.acao}</strong></td>
      <td>${r.detalhes || "-"}</td>`;
    tbody.appendChild(tr);
  });
}

function renderUsuarios() {
  const table = $("#usuariosTable");
  if (!table) return;
  
  const usuariosVisiveis = ESTADO.usuarios.filter((u) => !u.excluidoEm);
  $("#usuariosCount").textContent = `${usuariosVisiveis.length} conta(s)`;

  table.innerHTML = `<thead><tr>
      <th>Usuário</th><th>Permissão</th><th>Criado em</th><th>Último login</th><th></th>
    </tr></thead><tbody></tbody>`;

  const tbody = table.querySelector("tbody");

  usuariosVisiveis.forEach((u) => {
    const tr = document.createElement("tr");
    
    // Se o usuário estiver bloqueado, aplicamos um estilo CSS sutil (riscado + cinza)
    const estiloUsuario = u.bloqueado ? 'style="text-decoration: line-through; color: var(--texto-suave);"' : '';

    tr.innerHTML = `
      <td ${estiloUsuario}>${u.usuario} ${u.bloqueado ? '(Bloqueado)' : ''}</td>
      <td>${ROTULOS_PERMISSAO[u.permissao] || "Padrão"}</td>
      <td>${u.criadoEm ? new Date(u.criadoEm).toLocaleDateString("pt-BR") : "-"}</td>
      <td>${u.ultimoLogin ? new Date(u.ultimoLogin).toLocaleString("pt-BR") : "-"}</td>`;

    const tdMenu = document.createElement("td");

    const acaoBloqueio = u.bloqueado ? "Desbloquear" : "Bloquear";
    const outrasPermissoes = Object.keys(ROTULOS_PERMISSAO).filter((p) => p !== (u.permissao || "padrao"));

    tdMenu.innerHTML = `<details class="menu-linha"><summary>⋯</summary>
      <div class="menu-linha-opcoes">
        <button class="menu-linha-item" data-acao="bloqueio">${acaoBloqueio}</button>
        ${outrasPermissoes.map((p) =>
          `<button class="menu-linha-item eq-permissao-btn" data-permissao="${p}">Mudar para ${ROTULOS_PERMISSAO[p]}</button>`
        ).join("")}
        <button class="menu-linha-item menu-linha-excluir" data-acao="excluir">Excluir conta</button>
      </div>
    </details>`;

    // Lógica 1: Bloquear / Desbloquear
    tdMenu.querySelector('[data-acao="bloqueio"]').addEventListener("click", async () => {
      try {
        await updateDoc(doc(db, "usuarios", u.id), { bloqueado: !u.bloqueado });
        await registrarAuditoria(u.bloqueado ? "Desbloquear usuário" : "Bloquear usuário", u.usuario);
        toast(u.bloqueado ? "Usuário desbloqueado." : "Usuário bloqueado.");
      } catch (err) {
        console.error(err);
        toast("Erro: " + err.message);
      }
    });

    // Lógica 2: Mudar Permissão
    tdMenu.querySelectorAll('.eq-permissao-btn').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const novaPermissao = btn.dataset.permissao;
        try {
          await updateDoc(doc(db, "usuarios", u.id), { permissao: novaPermissao });
          await registrarAuditoria("Alterar permissão", `${u.usuario}: ${u.permissao} → ${novaPermissao}`);
          toast(`Permissão alterada com sucesso.`);
        } catch (err) {
          console.error(err);
          toast("Erro ao alterar permissão: " + err.message);
        }
      });
    });

    // Lógica 3: Excluir Conta
    // Não dá pra apagar de verdade o login (Firebase Auth) sem um backend
    // pago — então isso bloqueia a conta permanentemente e some ela da
    // lista. Sem isso, apagar só o perfil deixava a pessoa "ressuscitar"
    // a própria conta (com permissão padrão) só de logar de novo.
    tdMenu.querySelector('[data-acao="excluir"]').addEventListener("click", async () => {
      const ok = window.confirm(`Tem certeza que deseja excluir a conta de ${u.usuario}? Essa pessoa não vai mais conseguir acessar o sistema.`);
      if(!ok) return;

      try {
        await updateDoc(doc(db, "usuarios", u.id), {
          bloqueado: true,
          excluidoEm: new Date().toISOString(),
        });
        await registrarAuditoria("Excluir conta", u.usuario);
        toast("Conta excluída.");
      } catch (err) {
        console.error(err);
        toast("Erro ao excluir: " + err.message);
      }
    });

    tr.appendChild(tdMenu);
    tbody.appendChild(tr);
  });
}

function slugLocal(local) {
  return String(local).replace(/[^a-zA-Z0-9]/g, "_");
}

function locaisParaConfigurar() {
  const origem = ESTADO.equipamentos.length ? ESTADO.equipamentos : ESTADO.itensCarregados;
  const set = new Set(origem.map((e) => e.local || "SEDE"));
  return set.size ? [...set].sort() : ["SEDE"];
}

function iniciarSincronizacaoEquipes() {
  const q = query(collection(db, "equipes"), orderBy("predio"), orderBy("ordem"));
  onSnapshot(q, (snap) => {
    ESTADO.equipes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderEquipesPorPredio();
  }, (err) => console.error("Erro ao ler equipes:", err));
}

function nomeEquipePorVaga(predio, vaga, nEquipesFallback) {
  const cap = (ESTADO.config && ESTADO.config.capacidades && ESTADO.config.capacidades[predio]);
  
  // MODO NOVO: Se marcou "Definir equipes por nome", usa a lista selecionada
  if (cap && cap.modoRodizio && cap.equipesAtivas && cap.equipesAtivas.length > 0) {
    const index = vaga % cap.equipesAtivas.length;
    return cap.equipesAtivas[index];
  }

  // MODO ANTIGO: Segue puxando pelo número ("Equipes: 2") e a ordem de cadastro
  const ordem = (vaga % (nEquipesFallback || 1)) + 1;
  const encontrada = ESTADO.equipes.find((e) => e.predio === predio && e.ordem === ordem);
  return encontrada ? encontrada.nome : `Equipe ${ordem}`;
}
// Time atribuído em equipamentos é uma cópia do nome, não uma referência —
// então renomear a equipe não reflete sozinho no calendário/dashboard.
// Isso propaga o nome novo pra tudo que já está agendado no ciclo atual.
async function propagarRenomeacaoEquipe(nomeAntigo, nomeNovo) {
  if (!ESTADO.cicloAtual) return;
  const afetados = ESTADO.equipamentos.filter((e) => e.equipeResponsavel === nomeAntigo);
  if (!afetados.length) return;

  const TAMANHO_LOTE = 400;
  for (let inicio = 0; inicio < afetados.length; inicio += TAMANHO_LOTE) {
    const pedaco = afetados.slice(inicio, inicio + TAMANHO_LOTE);
    const batch = writeBatch(db);
    pedaco.forEach((item) => {
      batch.update(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", item.id), {
        equipeResponsavel: nomeNovo,
      });
    });
    await batch.commit();
  }
}

// Quando duas equipes trocam de posição (extra ↔ rotina), o trabalho que já
// estava no calendário também troca de dono — não só as vagas futuras.
async function propagarTrocaDeEquipes(nomeA, nomeB) {
  if (!ESTADO.cicloAtual) return;
  const afetados = ESTADO.equipamentos.filter((e) =>
    e.equipeResponsavel === nomeA || e.equipeResponsavel === nomeB
  );
  if (!afetados.length) return;

  const TAMANHO_LOTE = 400;
  for (let inicio = 0; inicio < afetados.length; inicio += TAMANHO_LOTE) {
    const pedaco = afetados.slice(inicio, inicio + TAMANHO_LOTE);
    const batch = writeBatch(db);
    pedaco.forEach((item) => {
      const novoNome = item.equipeResponsavel === nomeA ? nomeB : nomeA;
      batch.update(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", item.id), {
        equipeResponsavel: novoNome,
      });
    });
    await batch.commit();
  }
}

function renderEquipesPorPredio() {
  const container = $("#equipesPorPredio");
  if (!container) return;

  const predios = ESTADO.configSite.predios;
  const capacidades = (ESTADO.config && ESTADO.config.capacidades) || {};

  container.innerHTML = predios.map((predio) => {
    const cap = capacidades[predio] || { nEquipes: 2, modoRodizio: false, equipesAtivas: [] };
    const nEquipes = cap.nEquipes || 2;
    const equipesDoPredio = ESTADO.equipes.filter((e) => e.predio === predio).sort((a, b) => a.ordem - b.ordem);
    const maiorOrdem = equipesDoPredio.reduce((max, e) => Math.max(max, e.ordem), 0);
    const totalVagas = Math.max(nEquipes, maiorOrdem);

    const modoRodizio = cap.modoRodizio === true;
    const ativasPorNome = cap.equipesAtivas && cap.equipesAtivas.length > 0 ? cap.equipesAtivas : equipesDoPredio.map(e => e.nome);

    const vagasAtivasVazias = [];
    const equipesAcima = [];
    for (let o = 1; o <= nEquipes; o++) {
      const eq = equipesDoPredio.find((e) => e.ordem === o);
      if (eq) equipesAcima.push(eq);
      else vagasAtivasVazias.push(o);
    }

    let linhas = "";
    for (let ordem = 1; ordem <= totalVagas; ordem++) {
      const existente = equipesDoPredio.find((e) => e.ordem === ordem);
      const ehAbaixoDoLimite = ordem > nEquipes;
      const outrosPredios = predios.filter((p) => p !== predio);

      let badgeHtml = "";
      if (existente) {
          if (modoRodizio) {
              badgeHtml = ativasPorNome.includes(existente.nome)
                  // AZUL para quem está no rodízio
                  ? '<span class="status-select" style="font-size: 10px; padding: 2px 6px; cursor:default; background: var(--azul-700); color: white;">No rodízio</span>'
                  // LARANJA para quem está cadastrada mas não participa agora
                  : '<span class="status-select" style="font-size: 10px; padding: 2px 6px; cursor:default; background: #ea580c; color: white;">Corretiva</span>';
          } else {
              if (!ehAbaixoDoLimite) {
                  // AMARELO para o modo de Rotina original
                  badgeHtml = '<span class="status-select andamento" style="font-size: 10px; padding: 2px 6px; cursor:default;">Na rotina</span>';
              } else {
                  // CINZA CENTRALIZADO para Reserva
                  badgeHtml = '<span class="status-select" style="font-size: 10px; padding: 2px 6px; cursor:default; background:var(--borda); color:var(--texto-suave); text-align:center; justify-content:center; min-width:115px;">Reserva</span>';
              }
          }
      }

      linhas += `
        <div class="eq-linha">
          <span style="color: var(--borda-forte); font-size: 14px; margin-right: 4px;" title="Ordem/Vaga ${ordem}">⋮⋮</span>
          <input type="text" data-predio="${predio}" data-ordem="${ordem}" class="eq-nome-input"
            value="${existente ? existente.nome : ""}" placeholder="Nome da equipe ${ordem}...">
          ${badgeHtml}
          <details class="menu-linha">
            <summary>⋯</summary>
            <div class="menu-linha-opcoes">
              ${existente && modoRodizio && !ativasPorNome.includes(existente.nome) ? ativasPorNome.map((nomeAtivo) =>
                `<button class="menu-linha-item eq-trocar-rodizio-btn" data-predio="${predio}" data-entra="${existente.nome}" data-sai="${nomeAtivo}">Trocar com "${nomeAtivo}" (está no rodízio)</button>`
              ).join("") : ""}
              ${existente && !modoRodizio && ehAbaixoDoLimite ? equipesAcima.map((ativa) =>
                `<button class="menu-linha-item eq-promover-btn" data-id="${existente.id}" data-id-destino="${ativa.id}">Trocar posição com "${ativa.nome}"</button>`
              ).join("") : ""}
              ${existente && !modoRodizio && ehAbaixoDoLimite ? vagasAtivasVazias.map((vaga) =>
                `<button class="menu-linha-item eq-promover-vaga-btn" data-id="${existente.id}" data-vaga="${vaga}">Mover para vaga ${vaga} (vazia)</button>`
              ).join("") : ""}
              ${existente ? outrosPredios.map((p) =>
                `<button class="menu-linha-item eq-mover-btn" data-id="${existente.id}" data-destino="${p}">Mover para ${p}</button>`
              ).join("") : ""}
              ${existente ? `<button class="menu-linha-item menu-linha-excluir eq-excluir" data-id="${existente.id}">Excluir equipe</button>` : ""}
            </div>
          </details>
        </div>`;
    }

    const subtitulo = modoRodizio ? "Sistema de rodízio" : `${nEquipes} vagas por dia`;

    return `
      <div class="eq-predio-card">
        <div class="eq-predio-titulo">
          ${predio}
          <span class="badge-capacidade">${subtitulo}</span>
        </div>
        <div style="margin-bottom: 12px; display: flex; flex-direction: column; flex: 1;">
          ${linhas}
        </div>
        <button class="btn ghost btn-adicionar-vaga" data-predio="${predio}" style="margin-top:auto">+ Adicionar equipe</button>
      </div>`;
  }).join("");

  // Re-atachando os eventos originais
  container.querySelectorAll(".btn-adicionar-vaga").forEach((btn) => {
    btn.addEventListener("click", () => {
      const predio = btn.dataset.predio;
      const equipesDoPredio = ESTADO.equipes.filter((e) => e.predio === predio);
      const proximaOrdem = equipesDoPredio.reduce((max, e) => Math.max(max, e.ordem), 0) + 1;
      const nomeTemp = window.prompt(`Nome da nova equipe em ${predio}:`);
      if (!nomeTemp || !nomeTemp.trim()) return;
      addDoc(collection(db, "equipes"), { predio, ordem: proximaOrdem, nome: nomeTemp.trim() })
        .then(() => registrarAuditoria("Adicionar equipe", `${nomeTemp.trim()} — ${predio}`))
        .catch((err) => { console.error(err); toast("Erro ao adicionar: " + err.message); });
    });
  });

  container.querySelectorAll(".eq-nome-input").forEach((input) => {
    input.addEventListener("change", async () => {
      const predio = input.dataset.predio;
      const ordem = Number(input.dataset.ordem);
      const nome = input.value.trim();
      const existente = ESTADO.equipes.find((e) => e.predio === predio && e.ordem === ordem);
      try {
        if (!nome) {
          if (existente) await deleteDoc(doc(db, "equipes", existente.id));
          return;
        }
        if (existente) {
          const nomeAntigo = existente.nome;
          await updateDoc(doc(db, "equipes", existente.id), { nome });
          if (nomeAntigo && nomeAntigo !== nome) {
            await propagarRenomeacaoEquipe(nomeAntigo, nome);
          }
        } else {
          await addDoc(collection(db, "equipes"), { predio, ordem, nome });
        }
        await registrarAuditoria("Renomear/definir equipe", `${nome} — ${predio}`);
        toast("Equipe salva.");
      } catch (err) {
        console.error(err);
        toast("Erro ao salvar: " + err.message);
      }
    });
  });

  container.querySelectorAll(".eq-trocar-rodizio-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const predio = btn.dataset.predio;
      const entra = btn.dataset.entra;
      const sai = btn.dataset.sai;
      try {
        if (!ESTADO.config) ESTADO.config = {};
        if (!ESTADO.config.capacidades) ESTADO.config.capacidades = {};
        const cap = ESTADO.config.capacidades[predio] || { nEquipes: 2, aparelhosDia: 2, modoRodizio: true, equipesAtivas: [] };
        const lista = [...(cap.equipesAtivas || [])];
        const idx = lista.indexOf(sai);
        if (idx !== -1) lista[idx] = entra; else lista.push(entra);
        cap.equipesAtivas = lista;
        ESTADO.config.capacidades[predio] = cap;

        await setDoc(doc(db, "config", "cronograma"), ESTADO.config);
        await propagarRenomeacaoEquipe(sai, entra);
        await registrarAuditoria("Trocar equipe no rodízio", `${sai} → ${entra} — ${predio}`);
        toast(`"${entra}" entrou no rodízio no lugar de "${sai}".`);
        renderEquipesPorPredio();
      } catch (err) {
        console.error(err);
        toast("Erro ao trocar: " + err.message);
      }
    });
  });

  container.querySelectorAll(".eq-promover-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const extra = ESTADO.equipes.find((e) => e.id === btn.dataset.id);
      const ativa = ESTADO.equipes.find((e) => e.id === btn.dataset.idDestino);
      if (!extra || !ativa) return;
      try {
        const batch = writeBatch(db);
        batch.update(doc(db, "equipes", extra.id), { ordem: ativa.ordem });
        batch.update(doc(db, "equipes", ativa.id), { ordem: extra.ordem });
        await batch.commit();
        await propagarTrocaDeEquipes(extra.nome, ativa.nome);
        await registrarAuditoria("Trocar posição de equipe", `${extra.nome} ↔ ${ativa.nome} — ${extra.predio}`);
        toast(`Posições trocadas com sucesso.`);
      } catch (err) {
        console.error(err);
        toast("Erro ao trocar: " + err.message);
      }
    });
  });

  container.querySelectorAll(".eq-promover-vaga-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const extra = ESTADO.equipes.find((e) => e.id === btn.dataset.id);
      if (!extra) return;
      const novaOrdem = Number(btn.dataset.vaga);
      const nomeVagaFallback = `Equipe ${novaOrdem}`;
      try {
        await updateDoc(doc(db, "equipes", extra.id), { ordem: novaOrdem });
        await propagarRenomeacaoEquipe(nomeVagaFallback, extra.nome);
        await registrarAuditoria("Mover equipe para vaga vazia", `${extra.nome} — ${extra.predio}`);
        toast(`Posição alterada com sucesso.`);
      } catch (err) {
        console.error(err);
        toast("Erro ao promover: " + err.message);
      }
    });
  });

  container.querySelectorAll(".eq-mover-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const existente = ESTADO.equipes.find((e) => e.id === btn.dataset.id);
      if (!existente) return;
      const destino = btn.dataset.destino;

      const equipamentosPresos = ESTADO.equipamentos.filter(
        (e) => (e.local || "SEDE") === existente.predio && e.equipeResponsavel === existente.nome
      );
      if (equipamentosPresos.length) {
        const ok = window.confirm(
          `"${existente.nome}" tem ${equipamentosPresos.length} equipamento(s) agendado(s) em ${existente.predio}. Ao mover pra ${destino}, esses equipamentos vão continuar mostrando "${existente.nome}" como responsável. Quer continuar mesmo assim?`
        );
        if (!ok) return;
      }

      const equipesDoDestino = ESTADO.equipes.filter((e) => e.predio === destino);
      const novaOrdem = equipesDoDestino.reduce((max, e) => Math.max(max, e.ordem), 0) + 1;
      try {
        await updateDoc(doc(db, "equipes", existente.id), { predio: destino, ordem: novaOrdem });
        await registrarAuditoria("Mover equipe de prédio", `${existente.nome}: ${existente.predio} → ${destino}`);
        toast(`Equipe movida pra ${destino}.`);
      } catch (err) {
        console.error(err);
        toast("Erro ao mover: " + err.message);
      }
    });
  });

  container.querySelectorAll(".eq-excluir").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const existente = ESTADO.equipes.find((e) => e.id === btn.dataset.id);
      const equipamentosPresos = existente
        ? ESTADO.equipamentos.filter((e) => e.equipeResponsavel === existente.nome)
        : [];
      const aviso = equipamentosPresos.length
        ? `Excluir "${existente.nome}"? Ela tem ${equipamentosPresos.length} equipamento(s) que vão continuar mostrando essa equipe como responsável.`
        : "Excluir essa equipe?";
      const ok = window.confirm(aviso);
      if (!ok) return;
      try {
        await deleteDoc(doc(db, "equipes", btn.dataset.id));
        await registrarAuditoria("Excluir equipe", existente ? existente.nome : btn.dataset.id);
        toast("Equipe excluída.");
      } catch (err) {
        console.error(err);
        toast("Erro ao excluir: " + err.message);
      }
    });
  });
}

function renderCapacidadesPorPredio() {
  const container = $("#capacidadesPorPredio");
  if (!container) return;
  const locais = locaisParaConfigurar();
  const capacidadesAtuais = (ESTADO.config && ESTADO.config.capacidades) || {};

  container.innerHTML = locais.map((local) => {
    const slug = slugLocal(local);
    const cap = capacidadesAtuais[local] || { nEquipes: 2, aparelhosDia: 2, modoRodizio: false, equipesAtivas: [] };
    
    const modoRodizio = cap.modoRodizio === true;
    let painelAvancado = "";
    
    if (modoRodizio) {
        const equipesDoPredio = ESTADO.equipes.filter(e => e.predio === local).sort((a, b) => a.ordem - b.ordem);

        if (equipesDoPredio.length === 0) {
            painelAvancado = `<div style="width:100%; margin-top:10px; color:var(--vermelho);">Nenhuma equipe cadastrada neste prédio. Vá na aba "Configurações > Equipes".</div>`;
        } else {
            const ativas = cap.equipesAtivas && cap.equipesAtivas.length > 0 ? cap.equipesAtivas : equipesDoPredio.map(e => e.nome);

            const htmlEquipes = `<div style="display:flex; gap:12px; flex-wrap:wrap; margin-top:8px;">
              ${equipesDoPredio.map(e => `
                <label style="display:flex; align-items:center; gap:4px; font-weight:normal; text-transform:none;">
                  <input type="checkbox" class="chk-equipe-${slug}" value="${e.nome}" ${ativas.includes(e.nome) ? "checked" : ""}>
                  ${e.nome}
                </label>
              `).join("")}
            </div>`;

            painelAvancado = `
              <div style="width:100%; margin-top:12px; padding:12px; background:var(--azul-50); border:1px solid var(--borda); border-radius:var(--raio-pequeno);">
                <span style="font-size:11px; color:var(--texto-suave); font-weight:600; text-transform:uppercase;">
                  Equipes que participam do revezamento:
                </span>
                ${htmlEquipes}
              </div>
            `;
        }
    }

    return `
      <div class="capacidade-linha" style="display:flex; flex-direction:column; align-items:flex-start; padding: 16px 0; border-bottom: 1px solid var(--borda);">
        <div style="display:flex; align-items:center; gap: 16px; width: 100%; flex-wrap: wrap;">
          <span class="capacidade-nome" style="font-size:14px; min-width: 100px;">${local}</span>
          
          <label>Vagas por dia (Capacidade)
            <input type="number" min="1" id="nEquipes_${slug}" data-local="${local}" class="input-capacidade-equipes" value="${cap.nEquipes}" title="Quantas equipes trabalham simultaneamente por dia neste prédio">
          </label>
          
          <label>Aparelhos/vaga/dia
            <input type="number" min="1" id="aparelhosDia_${slug}" data-local="${local}" class="input-capacidade-aparelhos" value="${cap.aparelhosDia}">
          </label>
          
          <label style="margin-left: auto; display:flex; align-items:center; gap:6px; cursor:pointer;">
            <input type="checkbox" id="chkModoRodizio_${slug}" data-local="${local}" class="toggle-modo-rodizio" ${modoRodizio ? "checked" : ""}>
            Fazer rodízio
          </label>
        </div>
        ${painelAvancado}
      </div>
    `;
  }).join("");

  container.querySelectorAll(".toggle-modo-rodizio").forEach(chk => {
    chk.addEventListener("change", () => {
      const local = chk.dataset.local;
      const capTemporaria = lerCapacidadesDaTela();

      if (!ESTADO.config) ESTADO.config = {};
      if (!ESTADO.config.capacidades) ESTADO.config.capacidades = {};

      // Rede de segurança: se retornar vazio, cria uma configuração padrão
      ESTADO.config.capacidades[local] = capTemporaria[local] || {
          nEquipes: 2, aparelhosDia: 2, modoRodizio: false, equipesAtivas: []
      };

      ESTADO.config.capacidades[local].modoRodizio = chk.checked;
      renderCapacidadesPorPredio();
    });
  });
}

function lerCapacidadesDaTela() {
  const capacidades = {};
  const locais = locaisParaConfigurar();
  
  locais.forEach((local) => {
    const slug = slugLocal(local);
    const aparInput = $(`#aparelhosDia_${slug}`);
    const eqInput = $(`#nEquipes_${slug}`);
    if (!aparInput || !eqInput) return; 
    
    // Agora o número que manda na capacidade diária é SEMPRE o campo de Vagas/Equipes
    const nEquipesFixas = Math.max(1, parseInt(eqInput.value, 10) || 1);
    
    const chkModoRodizio = $(`#chkModoRodizio_${slug}`);
    const modoRodizio = chkModoRodizio ? chkModoRodizio.checked : false;

    const equipesAtivas = [];
    if (modoRodizio) {
        $all(`.chk-equipe-${slug}:checked`).forEach(chk => equipesAtivas.push(chk.value));
    }

    capacidades[local] = {
      aparelhosDia: Math.max(1, parseInt(aparInput.value, 10) || 1),
      nEquipes: nEquipesFixas, 
      modoRodizio: modoRodizio,
      equipesAtivas: equipesAtivas
    };
  });
  
  return capacidades;
}

function ligarBusca(inputId, chaveFiltro, renderFn) {
  const input = $(`#${inputId}`);
  if (!input) return;
  input.addEventListener("input", () => {
    ESTADO.filtros[chaveFiltro] = input.value.trim().toLowerCase();
    renderFn();
  });
}
ligarBusca("buscaEquipamentos", "equipamentos", renderEquipamentosCadastro);
ligarBusca("buscaFeriados", "feriados", renderFeriados);
ligarBusca("buscaOrdens", "ordens", renderOrdens);
ligarBusca("buscaHistorico", "historico", renderHistorico);
["filtroStatus", "filtroSetorPCM", "filtroOrigem"].forEach((id) => {
  $(`#${id}`)?.addEventListener("change", renderEquipamentosCadastro);
});

$("#prevMonth").addEventListener("click", () => mudarMes(-1));
$("#nextMonth").addEventListener("click", () => mudarMes(1));

function mudarMes(delta) {
  if (ESTADO.calMonth === null) { ESTADO.calMonth = new Date().getMonth(); ESTADO.calYear = new Date().getFullYear(); }
  ESTADO.calMonth += delta;
  if (ESTADO.calMonth < 0) { ESTADO.calMonth = 11; ESTADO.calYear--; }
  if (ESTADO.calMonth > 11) { ESTADO.calMonth = 0; ESTADO.calYear++; }
  renderCalendar();
}

const NOMES_MES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho",
  "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];

function renderCalendar() {
  const grid = $("#calendarGrid");
  if (ESTADO.calMonth === null) {
    const hoje = new Date();
    ESTADO.calYear = hoje.getFullYear();
    ESTADO.calMonth = hoje.getMonth();
  }
  $("#calendarTitle").textContent = `${NOMES_MES[ESTADO.calMonth]} de ${ESTADO.calYear}`;

  const hojeISO = formatISO(new Date());
  const porData = {};
  for (const item of aplicarFiltroLocal(ESTADO.equipamentos)) {
    (porData[item.dataAgendada] ||= []).push(item);
  }
  const datasVazias = new Set(
    (ESTADO.diasVaziosCronograma || [])
      .filter((d) => ESTADO.localFiltro === "Todos" || d.local === ESTADO.localFiltro)
      .map((d) => d.data)
  );

  grid.innerHTML = "";
  ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"].forEach((d) => {
    const el = document.createElement("div");
    el.className = "cal-dow";
    el.textContent = d;
    grid.appendChild(el);
  });

  const primeiroDia = new Date(ESTADO.calYear, ESTADO.calMonth, 1);
  const offsetInicial = (primeiroDia.getDay() + 6) % 7;
  const diasNoMes = new Date(ESTADO.calYear, ESTADO.calMonth + 1, 0).getDate();

  for (let i = 0; i < offsetInicial; i++) {
    const el = document.createElement("div");
    el.className = "cal-day empty";
    grid.appendChild(el);
  }

  for (let dia = 1; dia <= diasNoMes; dia++) {
    const iso = `${ESTADO.calYear}-${String(ESTADO.calMonth + 1).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
    const itensDoDia = porData[iso] || [];
    const feriadoDoDia = ESTADO.feriados.find((f) => iso >= f.dataInicio && iso <= f.dataFim);
    const ehDiaVazio = datasVazias.has(iso);
    const el = document.createElement("div");
    el.className = "cal-day" + (itensDoDia.length ? " has-tasks" : "") +
      (ESTADO.diaSelecionado === iso ? " selected" : "") + (feriadoDoDia ? " is-holiday" : "") +
      (ehDiaVazio ? " is-gap" : "");

    const num = document.createElement("div");
    num.className = "cal-day-num";
    num.textContent = dia;
    el.appendChild(num);

    if (ehDiaVazio) {
      const tag = document.createElement("div");
      tag.className = "cal-day-badge gap";
      tag.textContent = "Sem agenda";
      el.appendChild(tag);
    }

    if (feriadoDoDia) {
      const tag = document.createElement("div");
      tag.className = "cal-day-badge holiday";
      tag.textContent = feriadoDoDia.label || (feriadoDoDia.tipo === "feriado" ? "Feriado" : "Férias");
      el.appendChild(tag);
    }

    if (itensDoDia.length) {
    // Agrupa os itens do dia por prédio/anexo
    const porPredio = {};
    itensDoDia.forEach(i => {
      const p = i.local || "SEDE";
      (porPredio[p] = porPredio[p] || []).push(i);
    });

    // Cria uma etiqueta (badge) separada para cada prédio no mesmo dia
    // Cria uma etiqueta (badge) separada para cada prédio no mesmo dia
    const ROTULOS_STATUS = { pendente: "pendentes", andamento: "em andamento", concluido: "concluídos", atrasado: "atrasados" };
    Object.entries(porPredio).forEach(([predio, itensPredio]) => {
      const concluidas = itensPredio.filter((i) => i.statusPreventiva === "Concluída").length;
      const andamento = itensPredio.filter((i) => i.statusPreventiva === "Em andamento").length;
      const temAtrasado = iso < hojeISO && concluidas < itensPredio.length;
      
      const badge = document.createElement("div");
      let classe = "pendente";
      if (concluidas === itensPredio.length) classe = "concluido";
      else if (andamento > 0 || concluidas > 0) classe = "andamento";
      if (temAtrasado) classe = "atrasado";
      
      badge.className = "cal-day-badge " + classe + (ESTADO.localFiltro === "Todos" ? "" : " badge-empilhado");
      badge.innerHTML = ESTADO.localFiltro === "Todos"
        ? `<span class="badge-predio">${predio}</span><span class="badge-contagem">${itensPredio.length} ${ROTULOS_STATUS[classe]}</span>`
        : itensPredio.map((i) => `<div class="badge-maquina-linha">${i.patrimonio || i.ambiente}</div>`).join("");
      badge.addEventListener("mouseenter", (e) => mostrarTooltipCalendario(e.currentTarget, predio, itensPredio));
      badge.addEventListener("mouseleave", ocultarTooltipCalendario);
      badge.addEventListener("click", (e) => {
        e.stopPropagation();
        ocultarTooltipCalendario();
        selecionarDiaBadge(iso, predio, itensPredio);
      });
      el.appendChild(badge);
    });
    
    el.addEventListener("click", () => selecionarDia(iso));
  }
    grid.appendChild(el);
  }
}

function mostrarTooltipCalendario(elemento, predio, itens) {
  let tip = document.getElementById("calBadgeTooltip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "calBadgeTooltip";
    tip.className = "cal-badge-tooltip";
    document.body.appendChild(tip);
  }
  const preview = itens.slice(0, 3)
    .map((i) => `<div>${i.patrimonio || i.ambiente}</div>`)
    .join("");
  const resto = itens.length > 3 ? `<div class="cal-badge-tooltip-mais">+${itens.length - 3} mais</div>` : "";
  tip.innerHTML = `<strong>${predio}</strong>${preview}${resto}`;
  const rect = elemento.getBoundingClientRect();
  tip.style.left = `${rect.left}px`;
  tip.style.top = `${rect.bottom + 6}px`;
  tip.hidden = false;
}

function ocultarTooltipCalendario() {
  const tip = document.getElementById("calBadgeTooltip");
  if (tip) tip.hidden = true;
}

function selecionarDia(iso) {
  ESTADO.diaSelecionado = iso;
  renderCalendar();
  const itensDoDia = aplicarFiltroLocal(ESTADO.equipamentos).filter((i) => i.dataAgendada === iso);
  const [ano, mes, dia] = iso.split("-");
  $("#dayDetailCard").hidden = false;
  $("#dayDetailTitle").textContent = `${dia}/${mes}/${ano} — ${itensDoDia.length} aparelho(s)`;
  renderTabelaDetalheDia(itensDoDia, () => selecionarDia(iso));
  
  // CORREÇÃO MOBILE: Desliza a tela suavemente para baixo até a tabela
  if (window.innerWidth <= 768) {
    setTimeout(() => $("#dayDetailCard").scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
  }
}

function selecionarDiaBadge(iso, predio, itensPredio) {
  ESTADO.diaSelecionado = iso;
  renderCalendar();
  const [ano, mes, dia] = iso.split("-");
  $("#dayDetailCard").hidden = false;
  $("#dayDetailTitle").textContent = `${dia}/${mes}/${ano} — ${predio} (${itensPredio.length} aparelho(s))`;
  renderTabelaDetalheDia(itensPredio, () => {
    const itensAtualizados = aplicarFiltroLocal(ESTADO.equipamentos)
      .filter((i) => i.dataAgendada === iso && (i.local || "SEDE") === predio);
    selecionarDiaBadge(iso, predio, itensAtualizados);
  });
  
  // CORREÇÃO MOBILE: Desliza a tela suavemente para baixo até a tabela
  if (window.innerWidth <= 768) {
    setTimeout(() => $("#dayDetailCard").scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
  }
}

function renderTabelaDetalheDia(itensDoDia, aoAtualizar) {
  const table = $("#dayDetailTable");
  table.innerHTML = `<thead><tr><th>Patrimônio</th><th>Prédio</th><th>Setor</th><th>Ambiente</th><th>Equipe</th><th>Status</th></tr></thead><tbody></tbody>`;
  const tbody = table.querySelector("tbody");

  itensDoDia.forEach((item) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${item.patrimonio || "-"}</td><td>${item.local || "SEDE"}</td><td>${item.setor}</td><td>${item.ambiente}</td><td>${item.equipeResponsavel}</td>`;

    const tdStatus = document.createElement("td");
    const select = document.createElement("select");
    const atrasado = estaAtrasado(item);
    select.className = "status-select " + (atrasado ? "atrasado" : classeStatus(item.statusPreventiva));
    if (atrasado) {
      select.innerHTML = `
        <option value="${item.statusPreventiva}" hidden selected>Atrasado</option>
        <option value="Concluída">Concluída</option>
        <option value="Em andamento">Em andamento</option>
        <option value="Pendente">Pendente</option>
      `;
    } else {
      select.innerHTML = `
        <option value="Pendente" ${item.statusPreventiva === "Pendente" ? "selected" : ""}>Pendente</option>
        <option value="Em andamento" ${item.statusPreventiva === "Em andamento" ? "selected" : ""}>Em andamento</option>
        <option value="Concluída" ${item.statusPreventiva === "Concluída" ? "selected" : ""}>Concluída</option>
      `;
    }

    select.addEventListener("change", async () => {
      const statusAnterior = item.statusPreventiva;
      const statusNovo = select.value;

      if (statusNovo === "Concluída") {
        abrirModalConclusao(item, select, statusAnterior, aoAtualizar);
        return;
      }

      select.disabled = true;
      try {
        const camposStatus = {
          statusPreventiva: statusNovo,
          dataConclusao: statusNovo === "Concluída" ? formatISO(new Date()) : "",
        };
        if (statusNovo === "Concluída") {
          const proxima = await calcularProximaData({ ...item, dataConclusao: camposStatus.dataConclusao });
          camposStatus.proximaPreventiva = proxima.data;
          camposStatus.proximaPreventivaDia = proxima.dia;
        } else {
          camposStatus.proximaPreventiva = "";
          camposStatus.proximaPreventivaDia = "";
        }
        await updateDoc(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", item.id), camposStatus);
        Object.assign(item, camposStatus);

        const promessasLogs = [registrarHistorico(item, statusAnterior, statusNovo)];
        if (statusNovo === "Concluída") {
          promessasLogs.push(registrarOrdemServico(item));
        } else if (statusAnterior === "Concluída" && statusNovo !== "Concluída") {
          promessasLogs.push(removerOrdemServico(item.id));
        }
        await Promise.all(promessasLogs);

        aoAtualizar();
        toast(`Status atualizado com sucesso.`);
      } catch (err) {
        console.error(err);
        select.value = statusAnterior;
        select.className = "status-select " + classeStatus(statusAnterior);
        toast("Erro ao atualizar status: " + err.message);
      } finally {
        select.disabled = false;
      }
    });

    tdStatus.appendChild(select);
    tr.appendChild(tdStatus);
    tbody.appendChild(tr);
  });
}

function classeStatus(status) {
  if (status === "Concluída") return "concluido";
  if (status === "Em andamento") return "andamento";
  return "pendente";
}

function renderVisaoGerencial() {
  const elPredio = $("#visaoPorPredio");
  const elDias = $("#visaoProximosDias");
  const elEquipe = $("#visaoPorEquipe");
  if (!elPredio || !elDias || !elEquipe) return;

  const itens = ESTADO.equipamentos;

  // --- Por prédio ---
  const gruposPredio = new Map();
  itens.forEach((i) => {
    const l = i.local || "SEDE";
    if (!gruposPredio.has(l)) gruposPredio.set(l, []);
    gruposPredio.get(l).push(i);
  });
  const porPredio = [...gruposPredio.entries()]
    .map(([local, lista]) => {
      const concluidas = lista.filter((i) => i.statusPreventiva === "Concluída").length;
      const pct = lista.length ? Math.round((concluidas / lista.length) * 100) : 0;
      return { local, total: lista.length, concluidas, pct };
    })
    .sort((a, b) => a.local.localeCompare(b.local));

  elPredio.innerHTML = porPredio.map((p) => `
    <div class="vg-card">
      <p class="vg-titulo">${p.local}</p>
      <p class="vg-pct">${p.pct}%</p>
      <p class="vg-detalhe">${p.concluidas} de ${p.total} concluídos</p>
    </div>`).join("") || `<p class="muted">Nenhum aparelho carregado ainda.</p>`;

  // --- Próximos 7 dias ---
  const porData = {};
  itens.forEach((i) => { if (i.dataAgendada) porData[i.dataAgendada] = (porData[i.dataAgendada] || 0) + 1; });
  const hoje = new Date();
  const nomesCurtos = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
  let htmlDias = "";
  for (let n = 0; n < 7; n++) {
    const d = new Date(hoje);
    d.setDate(d.getDate() + n);
    const iso = formatISO(d);
    const diaSemanaIdx = (d.getDay() + 6) % 7;
    const fimDeSemana = diaSemanaIdx >= 5;
    htmlDias += `
      <div class="vg-dia${fimDeSemana ? " vg-fimdesemana" : ""}">
        <p class="vg-dia-nome">${nomesCurtos[diaSemanaIdx]}</p>
        <p class="vg-dia-num">${porData[iso] || 0}</p>
      </div>`;
  }
  elDias.innerHTML = htmlDias;

  // --- Por equipe, agrupado por prédio ---
  const gruposEquipe = new Map();
  itens.forEach((i) => {
    const l = i.local || "SEDE";
    if (!gruposEquipe.has(l)) gruposEquipe.set(l, new Map());
    const eq = i.equipeResponsavel || "Sem equipe";
    const porEq = gruposEquipe.get(l);
    if (!porEq.has(eq)) porEq.set(eq, []);
    porEq.get(eq).push(i);
  });

  const predios = [...gruposEquipe.keys()].sort();
  elEquipe.innerHTML = predios.map((local) => {
    const equipes = gruposEquipe.get(local);
    const linhas = [...equipes.entries()]
      .map(([equipe, lista]) => {
        const concluidas = lista.filter((i) => i.statusPreventiva === "Concluída").length;
        const pct = lista.length ? Math.round((concluidas / lista.length) * 100) : 0;
        return { equipe, total: lista.length, concluidas, pct };
      })
      .sort((a, b) => a.equipe.localeCompare(b.equipe));

    return `
      <div class="vg-equipe-grupo">
        <p class="vg-equipe-predio-nome">${local}</p>
        ${linhas.map((l) => `
          <div class="vg-equipe-linha">
            <span>${l.equipe}</span>
            <span style="color:var(--texto-suave)">${l.concluidas} de ${l.total} · ${l.pct}%</span>
          </div>`).join("")}
      </div>`;
  }).join("") || `<p class="muted">Nenhum aparelho carregado ainda.</p>`;
}

function renderResumoAtrasos() {
  const resumoEl = $("#resumoAtrasosResumo");
  const table = $("#atrasosTable");
  if (!resumoEl || !table) return;

  const atrasadosAgora = aplicarFiltroLocal(ESTADO.equipamentos).filter(estaAtrasado).length;

  const reagendamentos = aplicarFiltroLocal(
    ESTADO.historico.filter((h) => h.tipo === "Atraso Reagendado" && h.cicloId === ESTADO.cicloAtual)
  );

  const porPredio = {};
  reagendamentos.forEach((h) => {
    const local = h.local || "SEDE";
    porPredio[local] = (porPredio[local] || 0) + 1;
  });
  const resumoPredio = Object.entries(porPredio).map(([l, q]) => `${l}: ${q}`).join(" · ") || "nenhum";

  resumoEl.textContent = `Atrasos — ${atrasadosAgora} agora · ${reagendamentos.length} reagendado(s) neste ciclo (${resumoPredio})`;
  $("#atrasosCount").textContent = `${reagendamentos.length} registros`;

  table.innerHTML = `<thead><tr>
      <th>Patrimônio</th><th>Prédio</th><th>Setor</th><th>Equipe</th><th>De</th><th>Para</th><th>Quando</th>
    </tr></thead><tbody></tbody>`;
  const tbody = table.querySelector("tbody");

  if (!reagendamentos.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--texto-suave)">Nenhum atraso reagendado neste ciclo ainda.</td></tr>`;
    return;
  }

  [...reagendamentos]
    .sort((a, b) => String(b.registradoEm).localeCompare(String(a.registradoEm)))
    .forEach((h) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${h.patrimonio || "-"}</td>
        <td>${h.local || "SEDE"}</td>
        <td>${h.setor || "-"}</td>
        <td>${h.equipe || "-"}</td>
        <td>${formatarDataBR(h.dataAnterior)}</td>
        <td>${formatarDataBR(h.dataNova)}</td>
        <td>${new Date(h.registradoEm).toLocaleString("pt-BR")}</td>`;
      tbody.appendChild(tr);
    });
}

function renderDashboard() {
  // O aplicarFiltroLocal já garante que os números mudem quando você clica no filtro lá em cima
  const itens = aplicarFiltroLocal(ESTADO.equipamentos);
  const total = itens.length;
  const concluidas = itens.filter((i) => i.statusPreventiva === "Concluída").length;
  const andamento = itens.filter((i) => i.statusPreventiva === "Em andamento").length;
  const pendentes = total - concluidas - andamento;
  const execucao = total ? Math.round((concluidas / total) * 1000) / 10 : 0;

  const cartoes = [
    ["total", total, "Equipamentos"],
    ["concluido", concluidas, "Concluídas"],
    ["andamento", andamento, "Em andamento"],
    ["pendente", pendentes, "Pendentes"],
    ["execucao", `${execucao}%`, "Execução"],
  ];
  
  $("#kpiRow").innerHTML = cartoes.map(([cls, num, label]) =>
    `<div class="kpi-card ${cls}"><div class="num">${num}</div><div class="label">${label}</div></div>`
  ).join("");
  
  const cicloAtual = numeroDoCiclo(ESTADO.cicloAtual);
  const pct = total ? Math.round((concluidas / total) * 100) : 0;
  const elCiclo = $("#cicloResumo");
  if (elCiclo) {
    elCiclo.innerHTML = `
      <strong>Ciclo ${cicloAtual}</strong> — ${concluidas} de ${total} aparelhos concluídos (${pct}%)
      <div class="ciclo-barra"><span style="width:${pct}%"></span></div>`;
  }
  renderResumoAtrasos();
  renderVisaoGerencial();
}

async function registrarHistorico(item, statusAnterior, statusNovo, tipo = "Preventiva") {
  const agora = new Date();
  await addDoc(collection(     db,     "ciclos",     ESTADO.cicloAtual,     "historico" ), {
    equipamentoId: item.id,
    patrimonio: item.patrimonio || "",
    setor: item.setor || "",
    ambiente: item.ambiente || "",
    local: item.local || "SEDE",
    equipe: item.equipeResponsavel || "",
    usuario: ESTADO.usuarioNome || "",
    tipo,
    statusAnterior: statusAnterior || "-",
    statusNovo: statusNovo,
    registradoEm: agora.toISOString()
  });
}

async function registrarAuditoria(acao, detalhes) {
  try {
    await addDoc(collection(db, "auditoria"), {
      acao,
      detalhes: detalhes || "",
      usuario: ESTADO.usuarioNome || "",
      registradoEm: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Erro ao registrar auditoria:", err);
  }
}

async function registrarOrdemServico(item, checklist, avaliacaoEstrelas, tecnico) {
  const agora = new Date();

  // Só apaga ordens duplicadas DENTRO do ciclo atual — ordens de ciclos
  // fechados são histórico e não devem ser tocadas.
  const ordensAntigas = ESTADO.ordens.filter(
    (o) => o.equipamentoId === item.id && o.cicloId === ESTADO.cicloAtual
  );
  if (ordensAntigas.length > 0) {
    const batch = writeBatch(db);
    ordensAntigas.forEach((o) => batch.delete(doc(db, "ciclos", o.cicloId, "ordens", o.id)));
    await batch.commit();
  }

  // Agora ele grava a OS dentro da pasta do ciclo correto!
  await setDoc(doc(db, "ciclos", ESTADO.cicloAtual, "ordens", item.id), {
    equipamentoId: item.id,
    patrimonio: item.patrimonio || "",
    setor: item.setor || "",
    ambiente: item.ambiente || "",
    local: item.local || "SEDE",
    equipe: item.equipeResponsavel || "",
    dataAgendada: item.dataAgendada || "",
    status: "Concluída",
    registradoEm: agora.toISOString(),
    checklist: checklist || [],
    avaliacaoEstrelas: avaliacaoEstrelas || 0,
    tecnico: tecnico || "",
  });
}

async function removerOrdemServico(equipamentoId) {
  // Só remove a ordem do ciclo ATUAL — se esse aparelho já teve ordem em
  // ciclos anteriores (fechados), aquilo é histórico e continua intacto.
  const ordensDoEquipamento = ESTADO.ordens.filter(
    (o) => o.equipamentoId === equipamentoId && o.cicloId === ESTADO.cicloAtual
  );
  if (ordensDoEquipamento.length > 0) {
    const batch = writeBatch(db);
    ordensDoEquipamento.forEach((o) => batch.delete(doc(db, "ciclos", o.cicloId, "ordens", o.id)));
    await batch.commit();
  }
}

let modalConclusaoEstado = null;

function fecharModalConclusao(reverterSelect) {
  const overlay = $("#modalConclusaoOverlay");
  const modal = $("#modalConclusao");
  if (modal) modal.hidden = true;
  if (overlay) overlay.hidden = true;
  if (reverterSelect && modalConclusaoEstado && modalConclusaoEstado.selectEl) {
    modalConclusaoEstado.selectEl.value = modalConclusaoEstado.statusAnterior;
  }
  modalConclusaoEstado = null;
}

$("#modalConclusaoFechar")?.addEventListener("click", () => fecharModalConclusao(true));
$("#modalConclusaoOverlay")?.addEventListener("click", () => fecharModalConclusao(true));

function wireCampoOutro(selectId, wrapId, valorGatilho) {
  const select = $(`#${selectId}`);
  const wrap = $(`#${wrapId}`);
  if (!select || !wrap) return;
  select.addEventListener("change", () => {
    wrap.hidden = select.value !== valorGatilho;
  });
}

async function abrirModalConclusao(item, selectEl, statusAnterior, aoAtualizar) {
  modalConclusaoEstado = { item, selectEl, statusAnterior, aoAtualizar };

  $("#modalConclusaoTitulo").textContent = `Concluir preventiva — ${item.patrimonio || item.ambiente}`;
  $("#modalConclusaoCorpo").innerHTML = `
    <label>Técnico responsável *<input type="text" id="tecnicoConclusao" placeholder="Seu nome"></label>

    <h3 style="font-size:13px;color:var(--texto-suave);text-transform:uppercase;letter-spacing:.04em;margin:16px 0 10px">O que foi feito na máquina</h3>
    <div id="checklistPreventiva">
      ${CHECKLIST_PREVENTIVA.map((tarefa, i) => `
        <label class="checklist-item">
          <input type="checkbox" id="chkTarefa${i}" value="${tarefa}">
          ${tarefa}
        </label>
      `).join("")}
    </div>

    <h3 style="font-size:13px;color:var(--texto-suave);text-transform:uppercase;letter-spacing:.04em;margin:20px 0 6px">Avaliação do estado da máquina</h3>
    <div class="estrelas-widget" id="estrelasConclusao" data-valor="0">
      ${[1, 2, 3, 4, 5].map((n) => `<span class="estrela" data-valor="${n}">★</span>`).join("")}
    </div>

    <div style="display:flex;gap:12px;margin-top:24px">
      <button class="btn primary" id="btnModalConclusaoContinuar">Continuar</button>
      <button class="btn ghost" id="btnModalConclusaoCancelar">Cancelar</button>
    </div>
  `;

  const widget = $("#estrelasConclusao");
  widget.querySelectorAll(".estrela").forEach((estrela) => {
    estrela.addEventListener("click", () => {
      const valor = Number(estrela.dataset.valor);
      widget.dataset.valor = valor;
      widget.querySelectorAll(".estrela").forEach((e) => {
        e.classList.toggle("ativa", Number(e.dataset.valor) <= valor);
      });
    });
  });

  $("#btnModalConclusaoCancelar").addEventListener("click", () => fecharModalConclusao(true));

  $("#btnModalConclusaoContinuar").addEventListener("click", async () => {
    const tecnico = $("#tecnicoConclusao").value.trim();
    if (!tecnico) {
      toast("Preencha o nome do técnico responsável.");
      return;
    }
    modalConclusaoEstado.tecnico = tecnico;
    modalConclusaoEstado.checklist = CHECKLIST_PREVENTIVA.filter((_, i) => $(`#chkTarefa${i}`).checked);
    modalConclusaoEstado.avaliacaoEstrelas = Number(widget.dataset.valor) || 0;

    let dadosExistentes = null;
    try {
      const snap = await getDoc(doc(db, "infoCondensadoras", item.id));
      if (snap.exists()) dadosExistentes = snap.data();
    } catch (err) {
      console.error("Erro ao verificar info técnica:", err);
    }
    
    // Garante que a estrutura exista
    dadosExistentes = dadosExistentes || {};
    dadosExistentes.condensadora = dadosExistentes.condensadora || {};
    dadosExistentes.evaporadora = dadosExistentes.evaporadora || {};

    // INJEÇÃO AUTOMÁTICA: Oculta os campos que já vieram da planilha
    if (item.patrimonio) {
      dadosExistentes.evaporadora.tombo = dadosExistentes.evaporadora.tombo || item.patrimonio;
      dadosExistentes.condensadora.tombo = dadosExistentes.condensadora.tombo || item.patrimonio;
    }
    if (item.marca) {
      dadosExistentes.evaporadora.marca = dadosExistentes.evaporadora.marca || item.marca;
      dadosExistentes.condensadora.marca = dadosExistentes.condensadora.marca || item.marca;
    }
    if (item.modelo) {
      dadosExistentes.evaporadora.modelo = dadosExistentes.evaporadora.modelo || item.modelo;
      dadosExistentes.condensadora.modelo = dadosExistentes.condensadora.modelo || item.modelo;
    }
    if (item.capacidade) {
      dadosExistentes.evaporadora.capacidade = dadosExistentes.evaporadora.capacidade || item.capacidade;
      dadosExistentes.condensadora.capacidade = dadosExistentes.condensadora.capacidade || item.capacidade;
    }

    modalConclusaoEstado.dadosExistentes = dadosExistentes;

    const secaoCond = renderSecaoUnidade("cond", "Condensadora (unidade externa)", dadosExistentes.condensadora, "cond");
    const secaoEvap = renderSecaoUnidade("evap", "Evaporadora (unidade interna)", dadosExistentes.evaporadora, "evap");

    if (!secaoCond.html && !secaoEvap.html) {
      await finalizarConclusao();
    } else {
      renderPassoInfoTecnica(secaoCond, secaoEvap, dadosExistentes);
    }
  });

  $("#modalConclusao").hidden = false;
  $("#modalConclusaoOverlay").hidden = false;
}

// Define os campos técnicos de UMA unidade
function definirCamposUnidade(tipoUnidade) {
  const camposBase = [
    { chave: "tombo", tipo: "semOutro", rotulo: "Tombo/Patrimônio", labelSem: "Sem tombo", obrigatorio: false },
    { chave: "tag", tipo: "texto", rotulo: "Tag (se tiver)", obrigatorio: false },
    { chave: "marca", tipo: "select", opcoes: MARCAS_CONDENSADORA, rotulo: "Marca", obrigatorio: true },
    { chave: "capacidade", tipo: "select", opcoes: CAPACIDADES_CONDENSADORA, rotulo: "Capacidade", obrigatorio: true },
    { chave: "espessuraFio", tipo: "select", opcoes: ESPESSURAS_FIO, rotulo: "Espessura do fio de alimentação", obrigatorio: true },
  ];

  // "Modelo" só tem lista fixa (Split Hi-Wall/Inverter/Cassete/Piso-Teto)
  // pra evaporadora — são formatos de unidade interna. Na condensadora
  // continua texto livre, como sempre foi.
  if (tipoUnidade === "evap") {
    camposBase.push({ chave: "modelo", tipo: "select", opcoes: MODELOS_EVAPORADORA, rotulo: "Modelo", obrigatorio: true });
  } else {
    camposBase.push({ chave: "modelo", tipo: "semOutro", rotulo: "Modelo", labelSem: "Sem modelo", obrigatorio: false });
  }

  if (tipoUnidade === "cond") {
    camposBase.unshift({ chave: "numero", tipo: "texto", rotulo: "Nº (Condensadora)", obrigatorio: true });
  }

  return camposBase;
}

function renderSecaoUnidade(prefixo, titulo, dadosExistentes, tipoUnidade) {
  const existentes = dadosExistentes || {};
  const campos = definirCamposUnidade(tipoUnidade).filter((c) => {
    const valor = existentes[c.chave];
    return valor === undefined || valor === null || valor === "";
  });

  if (!campos.length) return { html: "", campos: [] };

  const html = `
    <h3 style="font-size:13px;color:var(--texto-suave);text-transform:uppercase;letter-spacing:.04em;margin:20px 0 10px">${titulo}</h3>
    <div class="grid-form">
      ${campos.map((c) => {
        const id = `${prefixo}_${c.chave}`;
        const marcador = c.obrigatorio ? " *" : "";
        if (c.tipo === "texto") {
          return "<label>" + c.rotulo + marcador + '<input type="text" id="' + id + '"></label>';
        }
        const opcoesExtras = c.tipo === "select"
          ? '<option value="">Selecione...</option>' + c.opcoes.map((o) => '<option value="' + o + '">' + o + '</option>').join("") + '<option value="Outro">Outro</option>'
          : '<option value="sem">' + c.labelSem + '</option><option value="outro">Outro</option>';
        return "" +
          "<div>" +
            "<label>" + c.rotulo + marcador +
              '<select id="' + id + '">' + opcoesExtras + "</select>" +
            "</label>" +
            '<div class="campo-outro" id="' + id + 'OutroWrap" hidden>' +
              '<input type="text" id="' + id + 'Outro" placeholder="Especifique">' +
            "</div>" +
          "</div>";
      }).join("")}
    </div>
  `;

  return { html, campos };
}
function wireSecaoUnidade(prefixo, campos) {
  campos.forEach((c) => {
    if (c.tipo === "select") wireCampoOutro(`${prefixo}_${c.chave}`, `${prefixo}_${c.chave}OutroWrap`, "Outro");
    if (c.tipo === "semOutro") wireCampoOutro(`${prefixo}_${c.chave}`, `${prefixo}_${c.chave}OutroWrap`, "outro");
  });
}

function lerSecaoUnidade(prefixo, campos, dadosExistentes) {
  const resultado = { ...(dadosExistentes || {}) };
  let faltouObrigatorio = false;

  campos.forEach((c) => {
    const id = `${prefixo}_${c.chave}`;
    const el = $(`#${id}`);
    if (!el) return;

    let valorFinal;
    if (c.tipo === "texto") {
      valorFinal = el.value.trim();
    } else if (c.tipo === "select") {
      valorFinal = el.value === "Outro" ? $(`#${id}Outro`).value.trim() : el.value;
    } else {
      valorFinal = el.value === "outro" ? $(`#${id}Outro`).value.trim() : "";
    }

    if (c.obrigatorio && !valorFinal) faltouObrigatorio = true;
    resultado[c.chave] = valorFinal;
  });

  return { resultado, faltouObrigatorio };
}

function renderPassoInfoTecnica(secaoCond, secaoEvap, dadosExistentes) {
  const { item } = modalConclusaoEstado;
  $("#modalConclusaoTitulo").textContent = "Dados técnicos da máquina";
  $("#modalConclusaoCorpo").innerHTML = `
    <p class="muted">Só está perguntando o que ainda não está registrado pra essa máquina. Da próxima vez, isso não é perguntado de novo.</p>
    <div class="grid-form">
      <label>Informante<input type="text" value="${modalConclusaoEstado.tecnico}" disabled></label>
      <label>Prédio<input type="text" value="${item.local || "SEDE"}" disabled></label>
    </div>
    ${secaoCond.html}
    ${secaoEvap.html}

    <div style="display:flex;gap:12px;margin-top:24px">
      <button class="btn primary" id="btnModalConclusaoSalvar">Salvar e concluir</button>
      <button class="btn ghost" id="btnModalConclusaoCancelar2">Cancelar</button>
    </div>
  `;

  wireSecaoUnidade("cond", secaoCond.campos);
  wireSecaoUnidade("evap", secaoEvap.campos);

  $("#btnModalConclusaoCancelar2").addEventListener("click", () => fecharModalConclusao(true));

  $("#btnModalConclusaoSalvar").addEventListener("click", async () => {
    const informante = modalConclusaoEstado.tecnico;

    const dadosCond = dadosExistentes.condensadora;
    const dadosEvap = dadosExistentes.evaporadora;
    const { resultado: condensadora, faltouObrigatorio: faltouCond } = lerSecaoUnidade("cond", secaoCond.campos, dadosCond);
    const { resultado: evaporadora, faltouObrigatorio: faltouEvap } = lerSecaoUnidade("evap", secaoEvap.campos, dadosEvap);

    if (faltouCond || faltouEvap) {
      toast("Preencha os campos obrigatórios (*).");
      return;
    }

    modalConclusaoEstado.infoTecnica = {
      informante,
      condensadora,
      evaporadora,
      local: item.local || "SEDE",
    };

    await finalizarConclusao();
  });
}

async function finalizarConclusao() {
  const { item, checklist, avaliacaoEstrelas, tecnico, infoTecnica, statusAnterior, aoAtualizar } = modalConclusaoEstado;
  const btnSalvar = $("#btnModalConclusaoSalvar") || $("#btnModalConclusaoContinuar");
  if (btnSalvar) btnSalvar.disabled = true;

  try {
    const camposStatus = {
      statusPreventiva: "Concluída",
      dataConclusao: formatISO(new Date()),
    };
    const proxima = await calcularProximaData({ ...item, dataConclusao: camposStatus.dataConclusao });
    camposStatus.proximaPreventiva = proxima.data;
    camposStatus.proximaPreventivaDia = proxima.dia;

    // O patrimônio do equipamento tem que vir do tombo da EVAPORADORA
    // (é essa etiqueta que vale como patrimônio oficial) — só cai pro
    // tombo da condensadora se a evaporadora não tiver um informado.
    const tomboInformado = (infoTecnica && infoTecnica.evaporadora && infoTecnica.evaporadora.tombo)
      || (infoTecnica && infoTecnica.condensadora && infoTecnica.condensadora.tombo);
    if (tomboInformado) {
      camposStatus.patrimonio = tomboInformado;
    }

    await updateDoc(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", item.id), camposStatus);
    Object.assign(item, camposStatus);

    const promessas = [
      registrarHistorico(item, statusAnterior, "Concluída"),
      registrarOrdemServico(item, checklist, avaliacaoEstrelas, tecnico),
    ];

    if (infoTecnica) {
      promessas.push(setDoc(doc(db, "infoCondensadoras", item.id), {
        ...infoTecnica,
        equipamentoId: item.id,
        preenchidoPor: ESTADO.usuarioNome || "",
        preenchidoEm: new Date().toISOString(),
      }, { merge: true }));
    }

    await Promise.all(promessas);

    toast("Preventiva concluída com sucesso.");
    fecharModalConclusao(false);
    if (typeof aoAtualizar === "function") aoAtualizar();
  } catch (err) {
    console.error(err);
    toast("Erro ao concluir: " + err.message);
  } finally {
    if (btnSalvar) btnSalvar.disabled = false;
  }
}

function iniciarSincronizacaoOrdens() {
  if (ESTADO.unsubscribeOrdens) ESTADO.unsubscribeOrdens();
  const q = query(collectionGroup(db, "ordens"), orderBy("registradoEm", "desc"), limit(300));
  ESTADO.unsubscribeOrdens = onSnapshot(q, (snap) => {
    ESTADO.ordens = snap.docs
      .filter((d) => d.ref.parent.parent) // ignora lixo de fora da estrutura de ciclos
      .map((d) => ({
        id: d.id,
        cicloId: d.ref.parent.parent.id,
        ...d.data()
      }));
    renderOrdens();
  }, (err) => {
    console.error(err);
    toast("Erro ao ler ordens de serviço: " + err.message);
  });
}
// APAGUEI A CHAMADA SOLTA QUE FICAVA AQUI EMBAIXO
iniciarSincronizacaoOrdens();

function iniciarSincronizacaoHistorico(){
  if (ESTADO.unsubscribeHistorico) ESTADO.unsubscribeHistorico();
  const q = query(collectionGroup(db, "historico"), orderBy("registradoEm", "desc"), limit(300));

  ESTADO.unsubscribeHistorico = onSnapshot(q, (snap) => {
    ESTADO.historico = snap.docs
      .filter((d) => d.ref.parent.parent)
      .map((d) => ({
        id: d.id,
        cicloId: d.ref.parent.parent.id,
        ...d.data()
      }));
    renderHistorico();
  }, (err) => {
    console.error(err);
    toast("Erro ao carregar histórico: " + err.message);
  });
}

function renderHistorico(){
  const table = $("#historicoTable");
  if(!table) return;
  const termo = ESTADO.filtros.historico;
  const historico = aplicarFiltroLocal(ESTADO.historico).filter((h) => {
    if (!termo) return true;
    const alvo = `${h.patrimonio || ""} ${h.setor || ""} ${h.equipe || ""}`.toLowerCase();
    return alvo.includes(termo);
  });
  
  $("#historicoCount").textContent = `${historico.length} registros`;
  
  // CORREÇÃO 1: Removida a palavra "Ações" no final do cabeçalho (deixado apenas <th></th>)
  table.innerHTML = `<thead><tr>
      <th style="width:30px"><input type="checkbox" id="checkTodosHistorico"></th>
      <th>Data/Hora</th><th>Patrimônio</th><th>Setor</th>
      <th>Equipe</th><th>Usuário</th><th>Tipo</th><th>De</th><th>Para</th><th></th>
  </tr></thead><tbody></tbody>`;
  
  const tbody = table.querySelector("tbody");

  historico.forEach(h => {
    const tr = document.createElement("tr");
    
    // CORREÇÃO 2: Agora ele reconhece "Reagendamento manual" e mostra as datas corretamente
    const ehReagendamento = h.tipo === "Atraso Reagendado" || h.tipo === "Reagendamento manual";
    
    const colDe = ehReagendamento
      ? `<td>${formatarDataBR(h.dataAnterior)}</td>`
      : `<td><span class="status-select ${classeStatus(h.statusAnterior)}">${h.statusAnterior || "-"}</span></td>`;
      
    const colPara = ehReagendamento
      ? `<td>${formatarDataBR(h.dataNova)}</td>`
      : `<td><span class="status-select ${classeStatus(h.statusNovo)}">${h.statusNovo}</span></td>`;
      
    tr.innerHTML = `
        <td></td>
        <td>${new Date(h.registradoEm).toLocaleString("pt-BR")}</td>
        <td>${h.patrimonio || "-"}</td>
        <td>${h.setor}</td>
        <td>${h.equipe}</td>
        <td>${h.usuario || "-"}</td>
        <td>${h.tipo || "Preventiva"}</td>
        ${colDe}
        ${colPara}
    `;

    const chaveSel = `${h.cicloId}::${h.id}`;
    const tdCheck = tr.children[0];
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = ESTADO.selecaoHistorico.has(chaveSel);
    chk.addEventListener("change", () => {
      if (chk.checked) ESTADO.selecaoHistorico.add(chaveSel);
      else ESTADO.selecaoHistorico.delete(chaveSel);
      atualizarBarraSelecao("selecaoHistorico", "selecaoHistorico", "selecaoHistoricoTexto");
    });
    tdCheck.appendChild(chk);

    const tdAcao = document.createElement("td");
    tdAcao.innerHTML = `<details class="menu-linha"><summary>⋯</summary>
      <div class="menu-linha-opcoes">
        <button class="menu-linha-item menu-linha-excluir" data-acao="excluir">Excluir</button>
      </div>
    </details>`;
    tdAcao.querySelector('[data-acao="excluir"]').addEventListener("click", () => deletarRegistroHistorico(h.cicloId, h.id));
    tr.appendChild(tdAcao);
    tbody.appendChild(tr);
  });

  const checkTodos = $("#checkTodosHistorico");
  if (checkTodos) {
    checkTodos.checked = historico.length > 0 &&
      historico.every((h) => ESTADO.selecaoHistorico.has(`${h.cicloId}::${h.id}`));
    checkTodos.addEventListener("change", () => {
      historico.forEach((h) => {
        const chave = `${h.cicloId}::${h.id}`;
        if (checkTodos.checked) ESTADO.selecaoHistorico.add(chave);
        else ESTADO.selecaoHistorico.delete(chave);
      });
      renderHistorico();
    });
  }

  atualizarBarraSelecao("selecaoHistorico", "selecaoHistorico", "selecaoHistoricoTexto");
}

function renderOrdens() {
  const table = $("#ordensTable");
  if (!table) return;
  const termo = ESTADO.filtros.ordens;
  const ordens = aplicarFiltroLocal(ESTADO.ordens).filter((o) => {
    if (!termo) return true;
    const alvo = `${o.patrimonio || ""} ${o.setor || ""} ${o.ambiente || ""} ${o.equipe || ""}`.toLowerCase();
    return alvo.includes(termo);
  });
  $("#ordensCount").textContent = `${ordens.length} OS Emitidas`;
  table.innerHTML = `<thead><tr>
      <th style="width:30px"><input type="checkbox" id="checkTodosOrdens"></th>
      <th>Data de Conclusão</th><th>Patrimônio</th><th>Setor</th><th>Ambiente</th>
      <th>Equipe</th><th>Ações</th>
    </tr></thead><tbody></tbody>`;
  const tbody = table.querySelector("tbody");

  ordens.forEach((o) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td></td>
      <td>${new Date(o.registradoEm).toLocaleString("pt-BR")}</td>
      <td>${o.patrimonio || "-"}</td>
      <td>${o.setor || ""}</td>
      <td>${o.ambiente || ""}</td>
      <td>${o.equipe || ""}</td>
    `;

    const chaveSel = `${o.cicloId}::${o.id}`;
    const tdCheck = tr.children[0];
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = ESTADO.selecaoOrdens.has(chaveSel);
    chk.addEventListener("change", () => {
      if (chk.checked) ESTADO.selecaoOrdens.add(chaveSel);
      else ESTADO.selecaoOrdens.delete(chaveSel);
      atualizarBarraSelecao("selecaoOrdens", "selecaoOrdens", "selecaoOrdensTexto");
    });
    tdCheck.appendChild(chk);

    const tdBtn = document.createElement("td");
    tdBtn.innerHTML = `<details class="menu-linha"><summary>⋯</summary>
      <div class="menu-linha-opcoes">
        <button class="menu-linha-item" data-acao="pmoc">Imprimir PMOC</button>
        <button class="menu-linha-item menu-linha-excluir" data-acao="excluir">Excluir</button>
      </div>
    </details>`;
    tdBtn.querySelector('[data-acao="pmoc"]').addEventListener("click", () => gerarPDFPMOC(o));
    tdBtn.querySelector('[data-acao="excluir"]').addEventListener("click", () => deletarRegistroOrdem(o.cicloId, o.id));
    tr.appendChild(tdBtn);
    tbody.appendChild(tr);
  });

  const checkTodos = $("#checkTodosOrdens");
  if (checkTodos) {
    checkTodos.checked = ordens.length > 0 &&
      ordens.every((o) => ESTADO.selecaoOrdens.has(`${o.cicloId}::${o.id}`));
    checkTodos.addEventListener("change", () => {
      ordens.forEach((o) => {
        const chave = `${o.cicloId}::${o.id}`;
        if (checkTodos.checked) ESTADO.selecaoOrdens.add(chave);
        else ESTADO.selecaoOrdens.delete(chave);
      });
      renderOrdens();
    });
  }

  atualizarBarraSelecao("selecaoOrdens", "selecaoOrdens", "selecaoOrdensTexto");
}

$("#btnExcluirSelecionadosOrdens")?.addEventListener("click", async () => {
  const chaves = [...ESTADO.selecaoOrdens];
  if (!chaves.length) return;
  const ok = window.confirm(`Excluir ${chaves.length} ordem(ns) de serviço selecionada(s)?`);
  if (!ok) return;
  try {
    const porCiclo = {};
    chaves.forEach((ch) => {
      const [cicloId, id] = ch.split("::");
      (porCiclo[cicloId] ||= []).push(id);
    });
    const TAMANHO_LOTE = 400;
    for (const [cicloId, ids] of Object.entries(porCiclo)) {
      for (let inicio = 0; inicio < ids.length; inicio += TAMANHO_LOTE) {
        const batch = writeBatch(db);
        ids.slice(inicio, inicio + TAMANHO_LOTE).forEach((id) => batch.delete(doc(db, "ciclos", cicloId, "ordens", id)));
        await batch.commit();
      }
    }
    ESTADO.selecaoOrdens.clear();
    toast(`${chaves.length} registro(s) excluído(s).`);
  } catch (err) {
    console.error(err);
    toast("Erro ao excluir: " + err.message);
  }
});

$("#btnExcluirSelecionadosHistorico")?.addEventListener("click", async () => {
  const chaves = [...ESTADO.selecaoHistorico];
  if (!chaves.length) return;
  const ok = window.confirm(`Excluir ${chaves.length} registro(s) de histórico selecionado(s)?`);
  if (!ok) return;
  try {
    const porCiclo = {};
    chaves.forEach((ch) => {
      const [cicloId, id] = ch.split("::");
      (porCiclo[cicloId] ||= []).push(id);
    });
    const TAMANHO_LOTE = 400;
    for (const [cicloId, ids] of Object.entries(porCiclo)) {
      for (let inicio = 0; inicio < ids.length; inicio += TAMANHO_LOTE) {
        const batch = writeBatch(db);
        ids.slice(inicio, inicio + TAMANHO_LOTE).forEach((id) => batch.delete(doc(db, "ciclos", cicloId, "historico", id)));
        await batch.commit();
      }
    }
    ESTADO.selecaoHistorico.clear();
    toast(`${chaves.length} registro(s) excluído(s).`);
  } catch (err) {
    console.error(err);
    toast("Erro ao excluir: " + err.message);
  }
});

function prepararEdicao(item) {
  idEquipamentoEmEdicao = item.id;
  $("#eqPatrimonio").value = item.patrimonio || "";
  $("#eqSetor").value = item.setor || "";
  $("#eqAmbiente").value = item.ambiente || "";
  if ($("#eqLocal")) $("#eqLocal").value = item.local || "SEDE";

  if (btnAdicionarEquipamento) {
    btnAdicionarEquipamento.textContent = "Salvar Alterações";
  }
  $("#eqSetor")?.focus();
  toast("Modo de edição ativado para o item selecionado.");
}

const btnAdicionarEquipamento = $("#btnAdicionarEquipamento");
if (btnAdicionarEquipamento) {
  btnAdicionarEquipamento.addEventListener("click", adicionarEquipamentoManual);
}

$("#btnBaixarCondensadoras")?.addEventListener("click", async () => {
  toast("Buscando dados técnicos...");
  try {
    const snap = await getDocs(collection(db, "infoCondensadoras"));
    const infoPorId = new Map();
    snap.docs.forEach((d) => infoPorId.set(d.id, d.data()));

    // Além das máquinas que já passaram pelo formulário de conclusão, inclui
    // as que já vieram completas da planilha (Marca/Modelo/Capacidade) mas
    // nunca foram concluídas — senão elas nunca apareciam nesse relatório,
    // mesmo já tendo o dado técnico disponível.
    const idsParaExportar = new Set(infoPorId.keys());
    ESTADO.equipamentos.forEach((item) => {
      if (!infoPorId.has(item.id) && (item.marca || item.modelo || item.capacidade)) {
        idsParaExportar.add(item.id);
      }
    });

    if (!idsParaExportar.size) {
      toast("Nenhuma máquina com dados técnicos preenchidos ainda.");
      return;
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Dados Técnicos");
    sheet.views = [{ showGridLines: false, state: "frozen", ySplit: 2 }];

    // Definindo as colunas
    sheet.columns = [
      // DADOS GERAIS (1 a 6)
      { key: "patrimonio", width: 16 },
      { key: "setor", width: 28 },
      { key: "ambiente", width: 28 },
      { key: "local", width: 14 },
      { key: "informante", width: 18 },
      { key: "preenchidoEm", width: 16 },
      // CONDENSADORA (7 a 13)
      { key: "condNumero", width: 10 },
      { key: "condTombo", width: 14 },
      { key: "condTag", width: 14 },
      { key: "condMarca", width: 14 },
      { key: "condModelo", width: 16 },
      { key: "condCapacidade", width: 16 },
      { key: "condFio", width: 16 },
      // EVAPORADORA (14 a 19)
      { key: "evapTombo", width: 14 },
      { key: "evapTag", width: 14 },
      { key: "evapMarca", width: 14 },
      { key: "evapModelo", width: 16 },
      { key: "evapCapacidade", width: 16 },
      { key: "evapFio", width: 16 },
    ];

    // LINHA 1: Super-Cabeçalhos (Mesclados)
    sheet.mergeCells('A1:F1');
    sheet.mergeCells('G1:M1');
    sheet.mergeCells('N1:S1');
    
    const r1 = sheet.getRow(1);
    r1.height = 25;
    r1.getCell(1).value = "DADOS GERAIS DA MÁQUINA";
    r1.getCell(7).value = "UNIDADE EXTERNA (CONDENSADORA)";
    r1.getCell(14).value = "UNIDADE INTERNA (EVAPORADORA)";

    // Estilo da Linha 1
    r1.eachCell((cell, colNumber) => {
      cell.font = { name: "Arial", bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      let cor = "FF1F4E78"; // Azul padrão para Geral
      if (colNumber >= 7 && colNumber <= 13) cor = "FF9C6500"; // Amarelo/Dourado escuro
      if (colNumber >= 14 && colNumber <= 19) cor = "FF375623"; // Verde escuro
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: cor } };
    });

    // LINHA 2: Cabeçalhos reais
    const r2 = sheet.getRow(2);
    r2.height = 20;
    r2.values = [
      "Patrimônio", "Setor", "Ambiente", "Prédio", "Informante", "Preenchido em",
      "Nº", "Tombo", "Tag", "Marca", "Modelo", "Capacidade", "Fio (mm)",
      "Tombo", "Tag", "Marca", "Modelo", "Capacidade", "Fio (mm)"
    ];

    // Estilo da Linha 2
    r2.eachCell((cell, colNumber) => {
      cell.font = { name: "Arial", bold: true, color: { argb: "FF000000" }, size: 10 };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = {
        top: { style: "thin", color: { argb: "FFBFBFBF" } },
        bottom: { style: "thin", color: { argb: "FFBFBFBF" } },
        left: { style: "thin", color: { argb: "FFBFBFBF" } },
        right: { style: "thin", color: { argb: "FFBFBFBF" } }
      };
      let cor = "FFEEF3F8"; // Fundo claro Geral
      if (colNumber >= 7 && colNumber <= 13) cor = "FFFFE699"; // Fundo claro Condensadora
      if (colNumber >= 14 && colNumber <= 19) cor = "FFC6E0B4"; // Fundo claro Evaporadora
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: cor } };
    });

    // Inserindo os Dados
    [...idsParaExportar].forEach((id, index) => {
      const dados = infoPorId.get(id) || null;
      const item = ESTADO.equipamentos.find((e) => e.id === id) || {};

      // Quando a máquina nunca passou pelo formulário (sem "dados"), usa o
      // que já veio da planilha pros dois lados — não dá pra saber se é da
      // condensadora ou da evaporadora, então mostra nos dois.
      const infoPlanilha = { marca: item.marca || "", modelo: item.modelo || "", capacidade: item.capacidade || "" };
      const cond = dados ? (dados.condensadora || {}) : infoPlanilha;
      const evap = dados ? (dados.evaporadora || {}) : infoPlanilha;

      const row = sheet.addRow({
        patrimonio: item.patrimonio || evap.tombo || "-", // Usa o tombo da evap se não tiver no item principal
        setor: item.setor || "-",
        ambiente: item.ambiente || "-",
        local: (dados && dados.local) || item.local || "-",
        informante: dados ? (dados.informante || "-") : "Planilha (levantamento)",
        preenchidoEm: dados && dados.preenchidoEm ? new Date(dados.preenchidoEm).toLocaleDateString("pt-BR") : "-",
        condNumero: cond.numero || "-", condTombo: cond.tombo || "-", condTag: cond.tag || "-",
        condMarca: cond.marca || "-", condModelo: cond.modelo || "-",
        condCapacidade: cond.capacidade || "-", condFio: cond.espessuraFio || "-",
        evapTombo: evap.tombo || "-", evapTag: evap.tag || "-",
        evapMarca: evap.marca || "-", evapModelo: evap.modelo || "-",
        evapCapacidade: evap.capacidade || "-", evapFio: evap.espessuraFio || "-",
      });

      // Borda fina e cores intercaladas (zebra) para leitura
      row.eachCell((cell) => {
        cell.font = { name: "Arial", size: 10 };
        cell.border = {
          top: { style: "thin", color: { argb: "FFE0E0E0" } },
          bottom: { style: "thin", color: { argb: "FFE0E0E0" } },
          left: { style: "thin", color: { argb: "FFE0E0E0" } },
          right: { style: "thin", color: { argb: "FFE0E0E0" } }
        };
        if (index % 2 !== 0) {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF9F9F9" } };
        }
      });
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Dados_Tecnicos_PMOC_${formatISO(new Date())}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast("Planilha baixada com sucesso!");
  } catch (err) {
    console.error(err);
    toast("Erro ao gerar planilha: " + err.message);
  }
});

async function adicionarEquipamentoManual() {
  const patrimonio = $("#eqPatrimonio").value.trim();
  const setor = $("#eqSetor").value.trim();
  const ambiente = $("#eqAmbiente").value.trim();

  if (!setor || !ambiente) {
    toast("Preencha pelo menos Setor e Ambiente.");
    return;
  }

  if (patrimonio) {
    const duplicado = ESTADO.equipamentos.find((e) =>
      e.patrimonio && e.patrimonio.trim() === patrimonio && e.id !== idEquipamentoEmEdicao
    );
    if (duplicado) {
      const ok = window.confirm(
        `Já existe um equipamento com o patrimônio "${patrimonio}" (${duplicado.setor} — ${duplicado.ambiente}, ${duplicado.local || "SEDE"}).\n\nQuer continuar mesmo assim?`
      );
      if (!ok) return;
    }
  }

  const setorPCM = identificarSetor(setor, ambiente);
  const prioridadeSetor = PRIORIDADE[setorPCM] || 7;
  const pisoPCM = descobrirPiso(setor);

  if (idEquipamentoEmEdicao) {
    const local = $("#eqLocal")?.value || "SEDE";
    const itemOriginal = ESTADO.equipamentos.find((e) => e.id === idEquipamentoEmEdicao);
    const localMudou = itemOriginal && (itemOriginal.local || "SEDE") !== local;
    // Só limpa e reagenda automaticamente quando o item ainda está Pendente —
    // pra um item Concluída/Em andamento, limpar a data quebraria ele (o
    // reagendarTudo() não recalcula quem não está pendente).
    const podeReagendar = localMudou && itemOriginal.statusPreventiva === "Pendente";
    try {
      const camposAtualizados = { patrimonio, setor, ambiente, local, setorPCM, prioridadeSetor, pisoPCM };
      if (podeReagendar) {
        // Equipe e data eram do prédio antigo — ficariam presas lá se não
        // limpar aqui, já que reagendarTudo() não mexe em quem já tem data.
        camposAtualizados.equipeResponsavel = "";
        camposAtualizados.dataAgendada = "";
        camposAtualizados.diaPlanejado = "";
        camposAtualizados.semanaPlanejada = "";
      }
      await updateDoc(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", idEquipamentoEmEdicao), camposAtualizados);
      await registrarHistorico(
        { id: idEquipamentoEmEdicao, patrimonio, setor, ambiente, local, equipeResponsavel: "" },
        "-", "Editado", "Cadastro"
      );
      idEquipamentoEmEdicao = null;
      if (btnAdicionarEquipamento) btnAdicionarEquipamento.textContent = "Adicionar Equipamento";
      if (podeReagendar) {
        toast("Prédio alterado — reagendando para a nova rotina...");
        await reagendarTudo();
      } else if (localMudou) {
        toast("Prédio alterado. Como o item já não está mais pendente, a equipe e a data não foram mexidas — confira manualmente se precisa ajustar.");
      } else {
        toast("Equipamento atualizado com sucesso!");
      }
    } catch (err) {
      console.error(err);
      toast("Erro ao atualizar: " + err.message);
      return;
    }
  } else {
    const id = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    const local = $("#eqLocal")?.value || "SEDE";
    const itensDoMesmoLocal = ESTADO.equipamentos.filter((e) => (e.local || "SEDE") === local);
    const maiorOrdem = itensDoMesmoLocal.reduce((max, e) => Math.max(max, e.ordemExecucao || 0), 0);
    const ordemExecucao = maiorOrdem + 1;
    const capLocal = (ESTADO.config && ESTADO.config.capacidades && ESTADO.config.capacidades[local]) || { nEquipes: 2, aparelhosDia: 2 };

    // Mesma fórmula da "roleta" usada em gerarCronograma() — aproxima em qual
    // dia esse item cairia (pelo tanto de itens que já existem nesse prédio)
    // pra escolher a equipe do rodízio de forma consistente com o resto do
    // cronograma, em vez de uma conta mais simples que ignorava o rodízio.
    let equipeResponsavel;
    if (capLocal.modoRodizio && capLocal.equipesAtivas && capLocal.equipesAtivas.length > 0) {
      const nVagas = Math.max(1, capLocal.nEquipes || 1);
      const capacidadeDia = nVagas * Math.max(1, capLocal.aparelhosDia || 1);
      const diasUteisJaUsados = Math.floor(itensDoMesmoLocal.length / capacidadeDia);
      const slotDaSala = (ordemExecucao - 1) % nVagas;
      const pool = capLocal.equipesAtivas;
      const indiceNoPool = (diasUteisJaUsados * nVagas + slotDaSala) % pool.length;
      equipeResponsavel = pool[indiceNoPool];
    } else {
      equipeResponsavel = nomeEquipePorVaga(local, ordemExecucao - 1, capLocal.nEquipes);
    }

    const item = {
      id, patrimonio, setor, ambiente,
      local,
      statusCondicao: "",
      setorPCM,
      prioridadeSetor,
      pisoPCM,
      statusPreventiva: "Pendente",
      observacao: "",
      origem: "manual",
      ordemExecucao,
      equipeResponsavel,
      dataAgendada: "",
      diaPlanejado: "",
      semanaPlanejada: "",
    };

    try {
      await setDoc(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", id), item);
      ESTADO.equipamentos.push(item);
      await registrarHistorico(item, "-", "Cadastrado", "Cadastro");
      toast("Equipamento adicionado. Agendando automaticamente...");
      await reagendarTudo();
    } catch (err) {
      console.error(err);
      toast("Erro ao adicionar: " + err.message);
      return;
    }
  }

  $("#eqPatrimonio").value = "";
  $("#eqSetor").value = "";
  $("#eqAmbiente").value = "";
}

async function removerEquipamento(id, descricao) {
  const ok = window.confirm(`Remover "${descricao}"? Essa ação não pode ser desfeita.`);
  if (!ok) return;
  try {
    await deleteDoc(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", id));
    toast("Equipamento removido. Reorganizando cronograma...");
    await reagendarTudo();
  } catch (err) {
    console.error(err);
    toast("Erro ao remover: " + err.message);
  }
}

function atualizarBarraSelecao(nomeSet, containerId, textoId) {
  const set = ESTADO[nomeSet];
  const container = $(`#${containerId}`);
  const texto = $(`#${textoId}`);
  
  if (!container) return;
  
  if (set.size > 0) {
    container.classList.add("visivel");
  } else {
    container.classList.remove("visivel");
  }
  
  if (texto) {
    texto.textContent = `${set.size} selecionado(s)`;
  }
}

// Lógica para o botão "X" limpar a seleção
$("#btnLimparSelecaoEquipamentos")?.addEventListener("click", () => {
  ESTADO.selecaoEquipamentos.clear(); // Limpa o Set
  
  // Desmarca o checkbox "Selecionar Todos" se existir
  const checkTodos = $("#checkTodosEquipamentos");
  if (checkTodos) checkTodos.checked = false;
  
  atualizarBarraSelecao("selecaoEquipamentos", "selecaoEquipamentos", "selecaoEquipamentosTexto");
  renderEquipamentosCadastro(); // Re-renderiza a tabela para desmarcar as linhas
});

function renderEquipamentosCadastro() {
  const table = $("#equipamentosTable");
  if (!table) return;
  const termo = ESTADO.filtros.equipamentos;
  const statusFiltro = $("#filtroStatus")?.value || "";
  const setorPCMFiltro = $("#filtroSetorPCM")?.value || "";
  const origemFiltro = $("#filtroOrigem")?.value || "";
  const filtrados = aplicarFiltroLocal(ESTADO.equipamentos).filter((item) => {
    if (termo) {
      const alvo = `${item.patrimonio || ""} ${item.setor || ""} ${item.ambiente || ""} ${item.setorPCM || ""} ${item.equipeResponsavel || ""}`.toLowerCase();
      if (!alvo.includes(termo)) return false;
    }
    if (statusFiltro) {
      if (statusFiltro === "Atrasado") { if (!estaAtrasado(item)) return false; }
      else if (item.statusPreventiva !== statusFiltro) return false;
    }
    if (setorPCMFiltro && item.setorPCM !== setorPCMFiltro) return false;
    if (origemFiltro) {
      const origemItem = item.origem === "manual" ? "manual" : "planilha";
      if (origemItem !== origemFiltro) return false;
    }
    return true;
  });

  let itensComCorretivas = filtrados.map((item) => {
    const { exatos, aproximados } = chamadosDoEquipamento(item);
    return { item, totalCorretivas: exatos.length + aproximados.length };
  });
  if (ESTADO.ordenacaoEquipamentos === "corretivas_desc") {
    itensComCorretivas.sort((a, b) => b.totalCorretivas - a.totalCorretivas);
  } else if (ESTADO.ordenacaoEquipamentos === "corretivas_asc") {
    itensComCorretivas.sort((a, b) => a.totalCorretivas - b.totalCorretivas);
  }

  $("#equipamentosCount").textContent = `${itensComCorretivas.length} itens`;
  const setaOrdenacao = ESTADO.ordenacaoEquipamentos === "corretivas_desc" ? " ▼"
    : ESTADO.ordenacaoEquipamentos === "corretivas_asc" ? " ▲" : " ⇅";
  table.innerHTML = `<thead><tr>
      <th style="width:30px"><input type="checkbox" id="checkTodosEquipamentos"></th>
      <th>Patrimônio</th><th>Setor</th><th>Ambiente</th><th>Prédio</th><th>Setor PCM</th>
      <th>Status</th><th>Origem</th><th>Marca/Modelo/Capacidade</th>
      <th id="thCorretivas" style="cursor:pointer" title="Clique para ordenar">Corretivas${setaOrdenacao}</th>
      <th></th>
    </tr></thead><tbody></tbody>`;
  const tbody = table.querySelector("tbody");

  itensComCorretivas.forEach(({ item, totalCorretivas }) => {
    const dadosTecnicos = [item.marca, item.modelo, item.capacidade].filter(Boolean).join(" • ") || "-";
    const tr = document.createElement("tr");
    tr.innerHTML = `<td></td><td>${item.patrimonio || "-"}</td><td>${item.setor}</td><td>${item.ambiente}</td>
      <td>${item.local || "SEDE"}</td>
      <td>${item.setorPCM}</td>
      <td>
        <span class="status-select ${classeStatus(item.statusPreventiva)}" style="cursor:default">${item.statusPreventiva}</span>
        ${estaAtrasado(item) ? '<span class="status-select atrasado" style="margin-left:6px;cursor:default">Atrasado</span>' : ""}
      </td>
      <td>${item.origem === "manual" ? "Manual" : "Planilha"}</td>
      <td style="font-size:12px">${dadosTecnicos}</td>
      <td style="text-align:center">${totalCorretivas > 0 ? `<strong>${totalCorretivas}</strong>` : "-"}</td>`;

    const tdCheck = tr.children[0];
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = ESTADO.selecaoEquipamentos.has(item.id);
    chk.addEventListener("click", (e) => e.stopPropagation());
    chk.addEventListener("change", () => {
      if (chk.checked) ESTADO.selecaoEquipamentos.add(item.id);
      else ESTADO.selecaoEquipamentos.delete(item.id);
      atualizarBarraSelecao("selecaoEquipamentos", "selecaoEquipamentos", "selecaoEquipamentosTexto");
    });
    tdCheck.appendChild(chk);

    const tdMenu = document.createElement("td");
    const btnMenu = document.createElement("button");
    btnMenu.className = "btn-menu";
    btnMenu.textContent = "⋯";
    btnMenu.title = "Ver detalhes";
    btnMenu.addEventListener("click", (e) => {
      e.stopPropagation();
      abrirDrawerEquipamento(item.id);
    });
    tdMenu.appendChild(btnMenu);
    tr.appendChild(tdMenu);
    tbody.appendChild(tr);
  });

  const checkTodos = $("#checkTodosEquipamentos");
  if (checkTodos) {
    checkTodos.checked = itensComCorretivas.length > 0 &&
      itensComCorretivas.every(({ item }) => ESTADO.selecaoEquipamentos.has(item.id));
    checkTodos.addEventListener("change", () => {
      itensComCorretivas.forEach(({ item }) => {
        if (checkTodos.checked) ESTADO.selecaoEquipamentos.add(item.id);
        else ESTADO.selecaoEquipamentos.delete(item.id);
      });
      renderEquipamentosCadastro();
    });
  }

  const thCorretivas = $("#thCorretivas");
  if (thCorretivas) {
    thCorretivas.addEventListener("click", () => {
      ESTADO.ordenacaoEquipamentos = ESTADO.ordenacaoEquipamentos === "corretivas_desc" ? "corretivas_asc" : "corretivas_desc";
      renderEquipamentosCadastro();
    });
  }

  atualizarBarraSelecao("selecaoEquipamentos", "selecaoEquipamentos", "selecaoEquipamentosTexto");
}

$("#btnExcluirSelecionadosEquipamentos")?.addEventListener("click", async () => {
  const ids = [...ESTADO.selecaoEquipamentos];
  if (!ids.length) return;
  const ok = window.confirm(`Excluir ${ids.length} equipamento(s) selecionado(s)? Essa ação não pode ser desfeita.`);
  if (!ok) return;
  try {
    for (const id of ids) {
      const item = ESTADO.equipamentos.find((e) => e.id === id);
      if (item) await registrarHistorico(item, "-", "Excluído", "Cadastro");
    }
    const TAMANHO_LOTE = 400;
    for (let inicio = 0; inicio < ids.length; inicio += TAMANHO_LOTE) {
      const batch = writeBatch(db);
      ids.slice(inicio, inicio + TAMANHO_LOTE).forEach((id) =>
        batch.delete(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", id))
      );
      await batch.commit();
    }
    ESTADO.selecaoEquipamentos.clear();
    await registrarAuditoria("Excluir equipamentos (em massa)", `${ids.length} itens`);
    toast(`${ids.length} equipamento(s) excluído(s). Reorganizando cronograma...`);
    await reagendarTudo();
  } catch (err) {
    console.error(err);
    toast("Erro ao excluir: " + err.message);
  }
});
// ------------------------------------------------------------------
// Painel lateral com detalhes do equipamento
// ------------------------------------------------------------------
function fecharDrawer() {
  $("#drawerEquipamento").hidden = true;
  $("#drawerOverlay").hidden = true;
}

$("#drawerFechar")?.addEventListener("click", fecharDrawer);
$("#drawerOverlay")?.addEventListener("click", fecharDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") fecharDrawer();
});

async function abrirDrawerEquipamento(id) {
  await carregarChamadosCorretivos();
  const item = ESTADO.equipamentos.find((e) => e.id === id);
  if (!item) return;

  // Busca o histórico desse aparelho em TODOS os ciclos, não só no atual —
  // senão, ao virar de ciclo, parecia que nunca tinha sido feita preventiva.
  let conclusoes = [];
  try {
    const qHist = query(collectionGroup(db, "historico"), where("equipamentoId", "==", id));
    const snapHist = await getDocs(qHist);
    conclusoes = snapHist.docs
      .map((d) => d.data())
      .filter((h) => h.statusNovo === "Concluída")
      .sort((a, b) => String(b.registradoEm).localeCompare(String(a.registradoEm)));
  } catch (err) {
    console.error("Erro ao buscar histórico completo:", err);
    conclusoes = ESTADO.historico
      .filter((h) => h.equipamentoId === id && h.statusNovo === "Concluída")
      .sort((a, b) => String(b.registradoEm).localeCompare(String(a.registradoEm)));
  }
  const ultimaPreventiva = conclusoes.length
    ? new Date(conclusoes[0].registradoEm).toLocaleString("pt-BR")
    : "Nunca registrada";

  const totalPreventivas = conclusoes.length;
  const { exatos, aproximados } = chamadosDoEquipamento(item);
  const linhaChamado = (c) =>
    `<div class="drawer-campo"><span class="rotulo">${c.dataFormatada || "-"}</span>
     <span class="valor">${c.solucionado || "-"} — ${c.descricaoProblema || c.pecaFaltante || "sem descrição"} (${c.equipe || "-"})</span></div>`;

  let infoTecnica = null;
  try {
    const snapInfo = await getDoc(doc(db, "infoCondensadoras", id));
    if (snapInfo.exists()) infoTecnica = snapInfo.data();
  } catch (err) {
    console.error("Erro ao buscar dados técnicos:", err);
  }
  const linhaInfoUnidade = (rotulo, dados) => {
    if (!dados) return `<div class="drawer-campo"><span class="rotulo">${rotulo}</span><span class="valor">Ainda não preenchido</span></div>`;
    return [
      ["Nº", dados.numero], ["Tombo", dados.tombo], ["Tag", dados.tag],
      ["Marca", dados.marca], ["Modelo", dados.modelo],
      ["Capacidade", dados.capacidade], ["Espessura do fio", dados.espessuraFio],
    ].map(([r, v]) => `<div class="drawer-campo"><span class="rotulo">${rotulo} — ${r}</span><span class="valor">${v || "-"}</span></div>`).join("");
  };

  $("#drawerTitulo").textContent = item.patrimonio ? `Patrimônio ${item.patrimonio}` : item.ambiente;

  $("#drawerCorpo").innerHTML = `
    <details class="drawer-secao" open>
      <summary>Situação</summary>
      <div class="drawer-campo"><span class="rotulo">Status</span>
        <span class="valor"><span class="status-select ${classeStatus(item.statusPreventiva)}" style="cursor:default">${item.statusPreventiva}</span>
        ${estaAtrasado(item) ? '<span class="status-select atrasado" style="margin-left:6px;cursor:default">Atrasado</span>' : ""}</span></div>
      <div class="drawer-campo"><span class="rotulo">${item.statusPreventiva === "Concluída" ? "Próximo ciclo previsto" : "Próxima preventiva"}</span><span class="valor">${formatarDataBR(item.statusPreventiva === "Concluída" ? item.proximaPreventiva : item.dataAgendada)} ${(item.statusPreventiva === "Concluída" ? item.proximaPreventivaDia : item.diaPlanejado) ? "(" + (item.statusPreventiva === "Concluída" ? item.proximaPreventivaDia : item.diaPlanejado) + ")" : ""}</span></div>
      <div class="drawer-campo"><span class="rotulo">Semana planejada</span><span class="valor">${item.semanaPlanejada || "-"}</span></div>
      <div class="drawer-campo"><span class="rotulo">Equipe responsável</span><span class="valor">${item.equipeResponsavel || "-"}</span></div>
      <div class="drawer-campo"><span class="rotulo">Última preventiva concluída</span><span class="valor">${ultimaPreventiva}</span></div>
      <div class="drawer-campo"><span class="rotulo">Total de preventivas feitas</span><span class="valor">${totalPreventivas}</span></div>
    </details>

    <details class="drawer-secao">
      <summary>Localização e classificação</summary>
      <div class="drawer-campo"><span class="rotulo">Prédio</span><span class="valor">${item.local || "SEDE"}</span></div>
      <div class="drawer-campo"><span class="rotulo">Setor</span><span class="valor">${item.setor || "-"}</span></div>
      <div class="drawer-campo"><span class="rotulo">Ambiente</span><span class="valor">${item.ambiente || "-"}</span></div>
      <div class="drawer-campo"><span class="rotulo">Setor PCM</span><span class="valor">${item.setorPCM || "-"}</span></div>
      <div class="drawer-campo"><span class="rotulo">Piso</span><span class="valor">${item.pisoPCM === 99 ? "Não identificado" : item.pisoPCM}</span></div>
      <div class="drawer-campo"><span class="rotulo">Condição (levantamento)</span><span class="valor">${item.statusCondicao || "-"}</span></div>
      <div class="drawer-campo"><span class="rotulo">Origem do cadastro</span><span class="valor">${item.origem === "manual" ? "Manual" : "Planilha"}</span></div>
    </details>

    <details class="drawer-secao">
      <summary>Chamados corretivos (planilha)</summary>
      ${exatos.length ? exatos.map(linhaChamado).join("") : '<div class="drawer-campo"><span class="rotulo">Vinculados por patrimônio</span><span class="valor">Nenhum</span></div>'}
      ${aproximados.length ? `
        <div style="margin-top:8px;font-size:11px;color:var(--texto-suave);text-transform:uppercase;letter-spacing:.03em">Prováveis (mesmo local, sem patrimônio no chamado)</div>
        ${aproximados.map(linhaChamado).join("")}
      ` : ""}
    </details>

    <details class="drawer-secao">
      <summary>Dados técnicos</summary>
      ${infoTecnica ? `
        <div class="drawer-campo"><span class="rotulo">Informante</span><span class="valor">${infoTecnica.informante || "-"}</span></div>
        <div class="drawer-campo"><span class="rotulo">Preenchido em</span><span class="valor">${infoTecnica.preenchidoEm ? new Date(infoTecnica.preenchidoEm).toLocaleString("pt-BR") : "-"}</span></div>
        ${linhaInfoUnidade("Condensadora", infoTecnica.condensadora)}
        ${linhaInfoUnidade("Evaporadora", infoTecnica.evaporadora)}
      ` : '<div class="drawer-campo"><span class="rotulo">Status</span><span class="valor">Ainda não preenchido</span></div>'}
    </details>

    <details class="drawer-secao drawer-form">
      <summary>Editar cadastro</summary>
      <label>Patrimônio<input type="text" id="drawerPatrimonio" value="${item.patrimonio || ""}"></label>
      <label>Setor<input type="text" id="drawerSetor" value="${item.setor || ""}"></label>
      <label>Ambiente<input type="text" id="drawerAmbiente" value="${item.ambiente || ""}"></label>
      <label>Prédio
        <select id="drawerLocal">
          ${ESTADO.configSite.predios.map((l) =>
            `<option value="${l}" ${(item.local || ESTADO.configSite.predios[0]) === l ? "selected" : ""}>${l}</option>`).join("")}
        </select>
      </label>
      <label>Marca<input type="text" id="drawerMarca" value="${item.marca || ""}" placeholder="Vem da planilha, se tiver"></label>
      <label>Modelo<input type="text" id="drawerModelo" value="${item.modelo || ""}" placeholder="Vem da planilha, se tiver"></label>
      <label>Capacidade<input type="text" id="drawerCapacidade" value="${item.capacidade || ""}" placeholder="Vem da planilha, se tiver"></label>
      <div class="drawer-acoes">
        <button class="btn primary" id="drawerSalvarCadastro">Salvar cadastro</button>
      </div>
    </details>

    <details class="drawer-secao drawer-form">
      <summary>Reagendar</summary>
      <label>Nova data da preventiva<input type="date" id="drawerNovaData" value="${item.dataAgendada || ""}"></label>
      <div class="drawer-acoes">
        <button class="btn primary" id="drawerSalvarData">Salvar nova data</button>
      </div>
    </details>

    <details class="drawer-secao drawer-form">
      <summary style="color:var(--vermelho)">Excluir</summary>
      <div class="drawer-acoes">
        <button class="btn ghost" id="drawerExcluir" style="color:var(--vermelho);border-color:var(--vermelho)">Excluir equipamento</button>
      </div>
    </details>
  `;

  $("#drawerSalvarCadastro").addEventListener("click", async () => {
    const patrimonio = $("#drawerPatrimonio").value.trim();
    const setor = $("#drawerSetor").value.trim();
    const ambiente = $("#drawerAmbiente").value.trim();
    const local = $("#drawerLocal").value;
    const marca = $("#drawerMarca").value.trim();
    const modelo = $("#drawerModelo").value.trim();
    const capacidade = $("#drawerCapacidade").value.trim();
    if (!setor || !ambiente) {
      toast("Preencha pelo menos Setor e Ambiente.");
      return;
    }
    const setorPCM = identificarSetor(setor, ambiente);
    try {
      await updateDoc(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", id), {
        patrimonio, setor, ambiente, local, setorPCM, marca, modelo, capacidade,
        prioridadeSetor: PRIORIDADE[setorPCM] || 7,
        pisoPCM: descobrirPiso(setor),
      });
      await registrarHistorico(
        { id, patrimonio, setor, ambiente, local, equipeResponsavel: item.equipeResponsavel },
        "-", "Editado", "Cadastro"
      );
      toast("Cadastro atualizado.");
      fecharDrawer();
    } catch (err) {
      console.error(err);
      toast("Erro ao salvar: " + err.message);
    }
  });

  $("#drawerSalvarData").addEventListener("click", async () => {
    const novaData = $("#drawerNovaData").value;
    if (!novaData) {
      toast("Escolha uma data.");
      return;
    }
    const [a, m, d] = novaData.split("-");
    const dataObj = new Date(a, parseInt(m, 10) - 1, d, 12, 0, 0);
    const novoDia = NOMES_DIAS[(dataObj.getDay() + 6) % 7];

    // Avisa se o dia escolhido já está no limite da capacidade daquele prédio
    const localItem = item.local || "SEDE";
    const cap = (ESTADO.config?.capacidades || {})[localItem] || { nEquipes: 1, aparelhosDia: 2 };
    const capacidadeDia = Math.max(1, cap.nEquipes) * Math.max(1, cap.aparelhosDia);
    const feriadoNoDia = ESTADO.feriados.find((f) => novaData >= f.dataInicio && novaData <= f.dataFim);
    if (feriadoNoDia) {
      const ok = window.confirm(
        `Esse dia é ${feriadoNoDia.tipo === "feriado" ? "feriado" : "período de férias"} (${feriadoNoDia.label}). Agendar mesmo assim?`
      );
      if (!ok) return;
    }

    const jaNoDia = ESTADO.equipamentos.filter(
      (e) => e.id !== id && (e.local || "SEDE") === localItem && e.dataAgendada === novaData
    ).length;

    if (jaNoDia >= capacidadeDia) {
      const ok = window.confirm(
        `Esse dia já tem ${jaNoDia} aparelho(s) em ${localItem}, no limite da capacidade (${capacidadeDia}/dia). Agendar mesmo assim?`
      );
      if (!ok) return;
    }

    try {
      await updateDoc(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", id), {
        dataAgendada: novaData,
        diaPlanejado: novoDia,
        fixadoManualmente: true 
      });
      await addDoc(collection(     db,     "ciclos",     ESTADO.cicloAtual,     "historico" ), {
        equipamentoId: id,
        patrimonio: item.patrimonio || "",
        setor: item.setor || "",
        ambiente: item.ambiente || "",
        local: item.local || "SEDE",
        usuario: ESTADO.usuarioNome || "",
        equipe: item.equipeResponsavel || "",
        tipo: "Reagendamento manual",
        dataAnterior: item.dataAgendada || "",
        dataNova: novaData,
        registradoEm: new Date().toISOString(),
      });
      toast(`Reagendado para ${formatarDataBR(novaData)}. Reorganizando o resto do cronograma...`);
      fecharDrawer();
      await reagendarTudo();
    } catch (err) {
      console.error(err);
      toast("Erro ao reagendar: " + err.message);
    }
  });

  $("#drawerExcluir").addEventListener("click", async () => {
    const ok = window.confirm(`Remover "${item.patrimonio || item.ambiente}"? Essa ação não pode ser desfeita.`);
    if (!ok) return;
    try {
      await registrarHistorico(item, "-", "Excluído", "Cadastro");
      await deleteDoc(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", id));
      toast("Equipamento removido. Reorganizando cronograma...");
      fecharDrawer();
      await reagendarTudo();
    } catch (err) {
      console.error(err);
      toast("Erro ao remover: " + err.message);
    }
  });

  $("#drawerEquipamento").hidden = false;
  $("#drawerOverlay").hidden = false;
}

const feriadoTipoSelect = $("#feriadoTipo");
if (feriadoTipoSelect) {
  feriadoTipoSelect.addEventListener("change", () => {
    $("#labelFeriadoFim").style.display = feriadoTipoSelect.value === "ferias" ? "flex" : "none";
  });
  feriadoTipoSelect.dispatchEvent(new Event("change"));
}

const btnAdicionarFeriado = $("#btnAdicionarFeriado");
if (btnAdicionarFeriado) {
  btnAdicionarFeriado.addEventListener("click", adicionarFeriado);
}

async function adicionarFeriado() {
  const tipo = $("#feriadoTipo").value;
  const label = $("#feriadoLabel").value.trim();
  const dataInicio = $("#feriadoInicio").value;
  const dataFimInput = $("#feriadoFim").value;
  if (!dataInicio) {
    toast("Escolha a data início.");
    return;
  }
  const dataFim = tipo === "feriado" ? dataInicio : (dataFimInput || dataInicio);
  if (dataFim < dataInicio) {
    toast("A data fim não pode ser antes da data início.");
    return;
  }
  try {
    const novoFeriado = { tipo, label: label || (tipo === "feriado" ? "Feriado" : "Férias"), dataInicio, dataFim };
    const refDoc = await addDoc(collection(db, "feriados"), novoFeriado);
    const snapFeriadosAtual = await getDocs(query(collection(db, "feriados"), orderBy("dataInicio")));
    ESTADO.feriados = snapFeriadosAtual.docs.map((d) => ({ id: d.id, ...d.data() }));
    await registrarAuditoria("Adicionar feriado/férias", `${novoFeriado.label} (${novoFeriado.dataInicio} a ${novoFeriado.dataFim})`);
    $("#feriadoLabel").value = "";
    $("#feriadoInicio").value = "";
    $("#feriadoFim").value = "";
    toast("Data cadastrada. Reorganizando cronograma...");
    await reagendarTudo();
  } catch (err) {
    console.error(err);
    toast("Erro ao cadastrar: " + err.message);
  }
}

async function removerFeriado(id, label) {
  const ok = window.confirm(`Remover "${label}"?`);
  if (!ok) return;
  try {
    await deleteDoc(doc(db, "feriados", id));
    ESTADO.feriados = ESTADO.feriados.filter((f) => f.id !== id);
    await registrarAuditoria("Remover feriado/férias", label);
    toast("Removido. Reorganizando cronograma...");
    await reagendarTudo(true);
  } catch (err) {
    console.error(err);
    toast("Erro ao remover: " + err.message);
  }
}

function iniciarSincronizacaoFeriados() {
  if (ESTADO.unsubscribeFeriados) ESTADO.unsubscribeFeriados();
  const q = query(collection(db, "feriados"), orderBy("dataInicio"));
  ESTADO.unsubscribeFeriados = onSnapshot(q, (snap) => {
    ESTADO.feriados = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderFeriados();
    renderCalendar();
  }, (err) => {
    console.error(err);
    toast("Erro ao ler feriados: " + err.message);
  });
}
iniciarSincronizacaoFeriados();

function renderFeriados() {
  const table = $("#feriadosTable");
  if (!table) return;

  const termo = ESTADO.filtros.feriados;
  const feriados = ESTADO.feriados.filter((f) => {
    if (!termo) return true;
    const alvo = `${f.label || ""} ${f.tipo || ""}`.toLowerCase();
    return alvo.includes(termo);
  });

  $("#feriadosCount").textContent = `${feriados.length} datas`;
  table.innerHTML = `<thead><tr><th>Tipo</th><th>Descrição</th><th>Início</th><th>Fim</th><th></th></tr></thead><tbody></tbody>`;
  const tbody = table.querySelector("tbody");
  feriados.forEach((f) => {
    const tr = document.createElement("tr");
    const [ai, am, ad] = f.dataInicio.split("-");
    const [bi, bm, bd] = f.dataFim.split("-");
    tr.innerHTML = `<td>${f.tipo === "feriado" ? "Feriado" : "Férias"}</td><td>${f.label}</td>
      <td>${ad}/${am}/${ai}</td><td>${bd}/${bm}/${bi}</td>`;
    const tdBtn = document.createElement("td");
    const btnDel = document.createElement("button");
    btnDel.className = "btn ghost";
    btnDel.textContent = "Remover";
    btnDel.addEventListener("click", () => removerFeriado(f.id, f.label));
    tdBtn.appendChild(btnDel);
    tr.appendChild(tdBtn);
    tbody.appendChild(tr);
  });
}

const FONT_NAME = "Arial";
const COR_HEADER = "FF1F4E78";
const COR_BANDA = "FFEEF3F8";
const COR_BORDA = "FFBFBFBF";
const STATUS_COND_COLORS = { RUIM: "FFF8CBAD", RAZOAVEL: "FFFFE699", BOM: "FFC6E0B4" };
const STATUS_PREV_COLORS = {
  Pendente: { fill: "FFF8CBAD", font: "FFC00000" },
  "Em andamento": { fill: "FFFFE699", font: "FF9C6500" },
  "Concluída": { fill: "FFC6E0B4", font: "FF375623" },
};
const NOME_ORGAO = "ASSEMBLEIA LEGISLATIVA DO ESTADO DO CEARÁ";
const NOME_SISTEMA = "Sistema de Planejamento da Manutenção Preventiva";
const NOME_MARCA = "PCM ALCE";

function colLetra(n) {
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function bordaFina() {
  const b = { style: "thin", color: { argb: COR_BORDA } };
  return { top: b, left: b, right: b, bottom: b };
}

function normalizarStatusPreventiva(valor) {
  const t = String(valor || "").trim().toUpperCase();
  if (t.includes("CONCL")) return "Concluída";
  if (t.includes("ANDAMENTO") || t.includes("EXECU")) return "Em andamento";
  return "Pendente";
}

function adicionarCabecalho(ws, ultimaColuna) {
  ultimaColuna = Math.max(ultimaColuna, 2);
  const linhas = [
    [NOME_ORGAO, 13, true],
    [NOME_SISTEMA, 11, false],
    [NOME_MARCA, 17, true],
  ];
  linhas.forEach(([texto, tam, negrito], i) => {
    const linha = i + 1;
    ws.mergeCells(linha, 1, linha, ultimaColuna);
    for (let c = 1; c <= ultimaColuna; c++) {
      const cell = ws.getCell(linha, c);
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COR_HEADER } };
    }
    const cell = ws.getCell(linha, 1);
    cell.value = texto;
    cell.font = { name: FONT_NAME, size: tam, bold: negrito, color: { argb: "FFFFFFFF" } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    ws.getRow(linha).height = linha === 3 ? 30 : 24;
  });
  return 5;
}

function calcularKpis(itens) {
  const total = itens.length;
  const concluidas = itens.filter((i) => normalizarStatusPreventiva(i.statusPreventiva) === "Concluída").length;
  const andamento = itens.filter((i) => normalizarStatusPreventiva(i.statusPreventiva) === "Em andamento").length;
  const pendentes = total - concluidas - andamento;
  const execucaoPct = total ? Math.round((concluidas / total) * 1000) / 10 : 0;
  const pisos = new Set(itens.filter((i) => i.pisoPCM !== 99).map((i) => i.pisoPCM)).size;
  const criticos = itens.filter((i) => String(i.statusCondicao || "").toUpperCase().includes("RUIM")).length;
  const equipes = new Set(itens.filter((i) => i.equipeResponsavel).map((i) => i.equipeResponsavel)).size;
  return { total, concluidas, andamento, pendentes, execucaoPct, pisos, criticos, equipes };
}

function formulasStatus(referencias) {
  if (!referencias) return null;
  const { colStatusPrev, colAmbiente, primeiraLinha, ultimaLinha } = referencias;
  const faixaStatus = `Cronograma!$${colStatusPrev}$${primeiraLinha}:$${colStatusPrev}$${ultimaLinha}`;
  const faixaTotal = `Cronograma!$${colAmbiente}$${primeiraLinha}:$${colAmbiente}$${ultimaLinha}`;
  return {
    total: `COUNTA(${faixaTotal})`,
    concluidas: `COUNTIF(${faixaStatus},"Concluída")`,
    andamento: `COUNTIF(${faixaStatus},"Em andamento")`,
    pendentes: `COUNTIF(${faixaStatus},"Pendente")`,
    execucao: `IFERROR(COUNTIF(${faixaStatus},"Concluída")/COUNTA(${faixaTotal}),0)`,
  };
}

function escreverKpis(ws, linhaInicio, kpis, referencias) {
  const formulas = formulasStatus(referencias);
  const cartoes = [
    ["Equipamentos", formulas ? formulas.total : kpis.total, "FF1F4E78"],
    ["Concluídas", formulas ? formulas.concluidas : kpis.concluidas, "FF548235"],
    ["Em andamento", formulas ? formulas.andamento : kpis.andamento, "FFBF8F00"],
    ["Pendentes", formulas ? formulas.pendentes : kpis.pendentes, "FFC00000"],
  ];
  let col = 1;
  const largura = 3, espaco = 1;
  const linhaNum = linhaInicio, linhaMeio = linhaInicio + 1, linhaLabel = linhaInicio + 2;

  cartoes.forEach(([label, valor, cor]) => {
    const c1 = col, c2 = col + largura - 1;
    for (const r of [linhaNum, linhaMeio, linhaLabel]) {
      for (let c = c1; c <= c2; c++) {
        const cell = ws.getCell(r, c);
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: cor } };
        cell.border = bordaFina();
      }
    }
    ws.mergeCells(linhaNum, c1, linhaMeio, c2);
    const cellNum = ws.getCell(linhaNum, c1);
    cellNum.value = typeof valor === "string" ? { formula: valor } : valor;
    cellNum.font = { name: FONT_NAME, size: 24, bold: true, color: { argb: "FFFFFFFF" } };
    cellNum.alignment = { horizontal: "center", vertical: "middle" };

    ws.mergeCells(linhaLabel, c1, linhaLabel, c2);
    const cellLab = ws.getCell(linhaLabel, c1);
    cellLab.value = label;
    cellLab.font = { name: FONT_NAME, size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    cellLab.alignment = { horizontal: "center", vertical: "middle" };

    col = c2 + 1 + espaco;
  });

  ws.getRow(linhaNum).height = 34;
  ws.getRow(linhaMeio).height = 10;
  ws.getRow(linhaLabel).height = 20;

  const linhaExec = linhaLabel + 2;
  const cellLabelExec = ws.getCell(linhaExec, 1);
  cellLabelExec.value = "Execução:";
  cellLabelExec.font = { name: FONT_NAME, size: 13, bold: true, color: { argb: "FF1F4E78" } };
  const cellValExec = ws.getCell(linhaExec, 2);
  cellValExec.value = formulas ? { formula: formulas.execucao } : kpis.execucaoPct / 100;
  cellValExec.font = { name: FONT_NAME, size: 13, bold: true, color: { argb: "FF1F4E78" } };
  cellValExec.numFmt = "0.0%";

  return linhaExec + 2;
}

function escreverTabelaContagem(ws, colInicio, linhaInicio, titulo, entradas) {
  const c1 = colInicio;
  if (titulo) {
    ws.getCell(linhaInicio, c1).value = titulo;
    ws.getCell(linhaInicio, c1).font = { name: FONT_NAME, bold: true, size: 11 };
  }
  let r = linhaInicio + 1;
  ws.getCell(r, c1).value = "Categoria";
  ws.getCell(r, c1 + 1).value = "Quantidade";
  for (const c of [c1, c1 + 1]) {
    const cell = ws.getCell(r, c);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COR_HEADER } };
    cell.font = { name: FONT_NAME, size: 11, bold: true, color: { argb: "FFFFFFFF" } };
  }
  r++;
  const primeiraLinhaDados = r;
  entradas.forEach(([label, qtd], i) => {
    const cellL = ws.getCell(r, c1);
    cellL.value = String(label);
    const cellQ = ws.getCell(r, c1 + 1);
    cellQ.value = qtd;
    cellL.border = bordaFina();
    cellQ.border = bordaFina();
    cellQ.alignment = { horizontal: "center" };
    if (i % 2 === 0) {
      cellL.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COR_BANDA } };
      cellQ.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COR_BANDA } };
    }
    r++;
  });
  return [primeiraLinhaDados, r - 1];
}

function contarPor(itens, chave) {
  const mapa = new Map();
  itens.forEach((i) => {
    const k = i[chave];
    mapa.set(k, (mapa.get(k) || 0) + 1);
  });
  return mapa;
}

function rotuloPiso(v) {
  if (v === 99) return "Não identificado";
  if (v === 0) return "Térreo/Subsolo";
  return `${v}º Piso`;
}


async function montarPlanilhaOrganizada(itens) {
  const kpis = calcularKpis(itens);
  const workbook = new ExcelJS.Workbook();

  const colunas = [
    ["patrimonio", "Patrimônio"], ["setor", "Setor"], ["ambiente", "Ambiente"],
    ["statusCondicao", "Status Condição"], ["setorPCM", "Setor PCM"], ["pisoPCM", "Piso"],
    ["semanaPlanejada", "Semana Planejada"], ["diaPlanejado", "Dia Planejado"],
    ["equipeResponsavel", "Equipe Responsável"], ["ordemExecucao", "Ordem Execução"],
    ["prioridadeSetor", "Prioridade"], ["statusPreventiva", "Status Preventiva"],
    ["observacao", "Observação"],
  ];
  const statusPrevIdx = colunas.findIndex(([k]) => k === "statusPreventiva") + 1;
  const ambienteIdx = colunas.findIndex(([k]) => k === "ambiente") + 1;
  const linhaCabecalhoTabela = 5;
  const primeiraLinhaDados = linhaCabecalhoTabela + 1;
  const ultimaLinha = primeiraLinhaDados + itens.length - 1;
  const referencias = {
    primeiraLinha: primeiraLinhaDados,
    ultimaLinha,
    colAmbiente: colLetra(ambienteIdx),
    colStatusPrev: colLetra(statusPrevIdx),
  };
  const formulasResumo = formulasStatus(referencias);

  const ws1 = workbook.addWorksheet("Resumo", { properties: { tabColor: { argb: "FF1F4E78" } } });
  ws1.views = [{ showGridLines: false }];
  let r = adicionarCabecalho(ws1, 2);
  ws1.getCell(r, 1).value = `Gerado em ${new Date().toLocaleString("pt-BR")}`;
  ws1.getCell(r, 1).font = { name: FONT_NAME, italic: true, size: 10, color: { argb: "FF808080" } };
  r += 2;

  const linhasResumo = [
    ["Total de equipamentos", formulasResumo ? { formula: formulasResumo.total } : kpis.total, null],
    ["Pisos atendidos", kpis.pisos, null],
    ["Equipamentos críticos", kpis.criticos, null],
    ["Concluídas", formulasResumo ? { formula: formulasResumo.concluidas } : kpis.concluidas, null],
    ["Em andamento", formulasResumo ? { formula: formulasResumo.andamento } : kpis.andamento, null],
    ["Pendentes", formulasResumo ? { formula: formulasResumo.pendentes } : kpis.pendentes, null],
    ["Execução (%)", formulasResumo ? { formula: formulasResumo.execucao } : kpis.execucaoPct / 100, "0.0%"],
    ["Equipes envolvidas", kpis.equipes, null],
  ];
  linhasResumo.forEach(([label, val, formato], i) => {
    const lc = ws1.getCell(r, 1);
    lc.value = label;
    lc.font = { name: FONT_NAME, size: 11 };
    lc.border = bordaFina();
    const c = ws1.getCell(r, 2);
    c.value = val;
    c.font = { name: FONT_NAME, size: 12, bold: true, color: { argb: "FF1F4E78" } };
    c.alignment = { horizontal: "center" };
    c.border = bordaFina();
    if (i % 2 === 0) {
      lc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COR_BANDA } };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COR_BANDA } };
    }
    if (formato) c.numFmt = formato;
    r++;
  });

  r += 1;
  const contagemSetor = [...contarPor(itens, "setorPCM").entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  escreverTabelaContagem(ws1, 1, r, "Equipamentos por prioridade", contagemSetor);

  ws1.getColumn(1).width = 48;
  ws1.getColumn(2).width = 20;
  ws1.getColumn(3).width = 4;

  const ws2 = workbook.addWorksheet("Cronograma", { properties: { tabColor: { argb: "FF2E8B7F" } } });
  ws2.views = [{ showGridLines: false, state: "frozen", ySplit: primeiraLinhaDados - 1 }];

  adicionarCabecalho(ws2, colunas.length);
  ws2.getRow(linhaCabecalhoTabela).height = 30;
  colunas.forEach(([, rotulo], i) => {
    const cell = ws2.getCell(linhaCabecalhoTabela, i + 1);
    cell.value = rotulo;
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COR_HEADER } };
    cell.font = { name: FONT_NAME, size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = bordaFina();
  });

  itens.forEach((item, offset) => {
    const rIdx = primeiraLinhaDados + offset;
    colunas.forEach(([chave], cIdx) => {
      let val = item[chave];
      if (chave === "statusPreventiva") val = normalizarStatusPreventiva(val);
      if (chave === "pisoPCM") val = val === 99 ? "" : val;
      const cell = ws2.getCell(rIdx, cIdx + 1);
      cell.value = val === undefined || val === null ? "" : val;
      cell.font = { name: FONT_NAME, size: 10 };
      cell.border = bordaFina();
      if (offset % 2 === 0) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COR_BANDA } };
      }
    });
  });

  const larguras = { 1: 14, 2: 24, 3: 30, 4: 14, 5: 22, 6: 8, 7: 14, 8: 12, 9: 14, 10: 10, 11: 12, 12: 14, 13: 24 };
  Object.entries(larguras).forEach(([i, w]) => {
    if (Number(i) <= colunas.length) ws2.getColumn(Number(i)).width = w;
  });

  const ultimaColunaLetra = colLetra(colunas.length);
  ws2.autoFilter = `A${linhaCabecalhoTabela}:${ultimaColunaLetra}${ultimaLinha}`;

  const ws3 = workbook.addWorksheet("Dashboard", { properties: { tabColor: { argb: "FFC9A34E" } } });
  ws3.views = [{ showGridLines: false }];
  let r3 = adicionarCabecalho(ws3, 15);
  r3 = escreverKpis(ws3, r3, kpis, referencias);
  r3 += 1;

  const contagemPiso = [...contarPor(itens, "pisoPCM").entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([v, qtd]) => [rotuloPiso(v), qtd]);
  const [, uSetor] = escreverTabelaContagem(ws3, 1, r3, "Equipamentos por prioridade", contagemSetor);
  let proxima = uSetor + 3;
  const [, uPiso] = escreverTabelaContagem(ws3, 1, proxima, "Equipamentos por andar", contagemPiso);

  ws3.getColumn(1).width = 26;
  ws3.getColumn(2).width = 14;

  return workbook;
}

$("#btnExport").addEventListener("click", async () => {
  if (!ESTADO.equipamentos.length) {
    toast("Gere o cronograma primeiro.");
    return;
  }
  toast("Montando planilha...");
  try {
    const workbook = await montarPlanilhaOrganizada(ESTADO.equipamentos);
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const agora = new Date();
    a.href = url;
    a.download = `PCM_ALCE_${agora.getFullYear()}_${String(agora.getMonth() + 1).padStart(2, "0")}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast("Planilha baixada!");
  } catch (err) {
    console.error(err);
    toast("Erro ao gerar planilha: " + err.message);
  }
});

const btnExportarPDF = $("#btnExportarPDF");
if (btnExportarPDF) {
  btnExportarPDF.addEventListener("click", () => {
    if (!ESTADO.equipamentos.length) {
      toast("Gere o cronograma primeiro.");
      return;
    }
    toast("Gerando relatório PDF...");
    baixarRelatorioPDF(ESTADO.equipamentos, ESTADO.cicloAtual, ESTADO.historico);
  });
}

const btnApagarCronograma = $("#btnApagarCronograma");
if (btnApagarCronograma) {
  btnApagarCronograma.addEventListener("click", apagarCronograma);
}

async function apagarCronograma() {
  if (!ESTADO.equipamentos.length) {
    toast("Não há cronograma para apagar.");
    return;
  }

  const confirmado = window.confirm(
    `Isso vai apagar TODOS os ${ESTADO.equipamentos.length} equipamentos do cronograma atual. Continuar?`
  );
  if (!confirmado) return;

  btnApagarCronograma.disabled = true;
  toast("Apagando cronograma...");
  try {
    await registrarAuditoria("Apagar cronograma", `${ESTADO.equipamentos.length} equipamentos removidos`);
    const ids = ESTADO.equipamentos.map(eq => eq.id);

    const TAMANHO_LOTE = 400;
    for (let inicio = 0; inicio < ids.length; inicio += TAMANHO_LOTE) {
      const pedaco = ids.slice(inicio, inicio + TAMANHO_LOTE);
      const batch = writeBatch(db);
      pedaco.forEach((id) => batch.delete(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", id)));
      await batch.commit();
    }

    ESTADO.equipamentos = [];
    ESTADO.itensCarregados = [];
    ESTADO.diaSelecionado = null;
    ESTADO.config = null;
    try {
      await deleteDoc(doc(db, "config", "cronograma"));
    } catch (e) {
      // pode não existir ainda, tudo bem
    }

    $("#previewCard").hidden = true;
    $("#resumoCapacidade").textContent = "";
    $("#dayDetailCard").hidden = true;

    ESTADO.diasVaziosCronograma = [];
    renderCalendar();
    renderDashboard();
    atualizarBannerAtrasados();
    atualizarAlertaDiasVazios();

    toast(`Cronograma apagado (${ids.length} itens removidos).`);
  } catch (err) {
    console.error(err);
    toast("Erro ao apagar cronograma: " + err.message);
  } finally {
    btnApagarCronograma.disabled = false;
  }
}
const btnApagarDadosTecnicos = $("#btnApagarDadosTecnicos");
if (btnApagarDadosTecnicos) {
  btnApagarDadosTecnicos.addEventListener("click", apagarDadosTecnicos);
}

async function apagarDadosTecnicos() {
  const confirmado = window.confirm(
    "Isso vai apagar TODOS os dados técnicos (Marca, Modelo, Capacidade, Fio, etc.) salvos de TODAS as máquinas permanentemente, voltando o sistema ao estado zero. Continuar?"
  );
  if (!confirmado) return;

  btnApagarDadosTecnicos.disabled = true;
  toast("Apagando dados técnicos do banco...");
  try {
    await registrarAuditoria("Apagar dados técnicos", "Limpou toda a base de informações técnicas");
    
    // Busca todos os documentos salvos na pasta infoCondensadoras
    const snap = await getDocs(collection(db, "infoCondensadoras"));
    const ids = snap.docs.map(d => d.id);

    if (!ids.length) {
      toast("Não há dados técnicos salvos para apagar.");
      btnApagarDadosTecnicos.disabled = false;
      return;
    }

    // Apaga em lotes para não sobrecarregar o Firebase
    const TAMANHO_LOTE = 400;
    for (let inicio = 0; inicio < ids.length; inicio += TAMANHO_LOTE) {
      const pedaco = ids.slice(inicio, inicio + TAMANHO_LOTE);
      const batch = writeBatch(db);
      pedaco.forEach((id) => batch.delete(doc(db, "infoCondensadoras", id)));
      await batch.commit();
    }

    toast(`Limpeza concluída! ${ids.length} registros técnicos foram apagados.`);
  } catch (err) {
    console.error(err);
    toast("Erro ao apagar dados técnicos: " + err.message);
  } finally {
    btnApagarDadosTecnicos.disabled = false;
  }
}

async function apagarColecaoCompleta(nomeColecao, mensagem) {

  if (!ESTADO.cicloAtual) {
    toast("Nenhum ciclo selecionado.");
    return;
  }

  const confirmado = window.confirm(mensagem);
  if (!confirmado) return;

  try {

    const colecaoRef = collection(
      db,
      "ciclos",
      ESTADO.cicloAtual,
      nomeColecao
    );

    const snap = await getDocs(colecaoRef);

    const ids = snap.docs.map((d) => d.id);

    if (!ids.length) {
      toast("Não há registros para apagar.");
      return;
    }

    const TAMANHO_LOTE = 400;

    for (let inicio = 0; inicio < ids.length; inicio += TAMANHO_LOTE) {

      const batch = writeBatch(db);

      ids
        .slice(inicio, inicio + TAMANHO_LOTE)
        .forEach((id) => {

          batch.delete(
            doc(
              db,
              "ciclos",
              ESTADO.cicloAtual,
              nomeColecao,
              id
            )
          );

        });

      await batch.commit();

    }

    toast(`${ids.length} registro(s) apagado(s).`);

  } catch (err) {

    console.error(err);
    toast("Erro ao apagar: " + err.message);

  }
}

const btnLimparHistorico = $("#btnLimparHistorico");
if (btnLimparHistorico) {
  btnLimparHistorico.addEventListener("click", apagarTodoHistoricoTodosOsCiclos);
}

async function apagarTodoHistoricoTodosOsCiclos() {
  const ok = window.confirm(
    "Isso vai apagar TODO o histórico de manutenção de TODOS os ciclos, permanentemente. Continuar?"
  );
  if (!ok) return;
  try {
    const snap = await getDocs(collectionGroup(db, "historico"));
    const refs = snap.docs.map((d) => d.ref);
    if (!refs.length) {
      toast("Não há registros para apagar.");
      return;
    }
    const TAMANHO_LOTE = 400;
    for (let inicio = 0; inicio < refs.length; inicio += TAMANHO_LOTE) {
      const batch = writeBatch(db);
      refs.slice(inicio, inicio + TAMANHO_LOTE).forEach((ref) => batch.delete(ref));
      await batch.commit();
    }
    await registrarAuditoria("Apagar histórico completo", `${refs.length} registros`);
    toast(`${refs.length} registro(s) apagado(s).`);
  } catch (err) {
    console.error(err);
    toast("Erro ao apagar: " + err.message);
  }
}
const btnLimparOrdens = $("#btnLimparOrdens");
if (btnLimparOrdens) {
  btnLimparOrdens.addEventListener("click", apagarTodasOrdensTodosOsCiclos);
}

async function apagarTodasOrdensTodosOsCiclos() {
  const ok = window.confirm(
    "Isso vai apagar TODAS as ordens de serviço de TODOS os ciclos, permanentemente. Continuar?"
  );
  if (!ok) return;
  try {
    const snap = await getDocs(collectionGroup(db, "ordens"));
    const refs = snap.docs.map((d) => d.ref);
    if (!refs.length) {
      toast("Não há registros para apagar.");
      return;
    }
    const TAMANHO_LOTE = 400;
    for (let inicio = 0; inicio < refs.length; inicio += TAMANHO_LOTE) {
      const batch = writeBatch(db);
      refs.slice(inicio, inicio + TAMANHO_LOTE).forEach((ref) => batch.delete(ref));
      await batch.commit();
    }
    await registrarAuditoria("Apagar todas as ordens", `${refs.length} registros`);
    toast(`${refs.length} registro(s) apagado(s).`);
  } catch (err) {
    console.error(err);
    toast("Erro ao apagar: " + err.message);
  }
}
function gerarPDFPMOC(ordem) {
  const eqFull = ESTADO.equipamentos.find(e => e.id === ordem.equipamentoId) || {};

  const idEquip = eqFull.patrimonio || ordem.patrimonio || "Sem Patrimônio";
  const setor = eqFull.setorPCM || ordem.setor || "Não informado";
  const ambiente = eqFull.ambiente || ordem.ambiente || "-";
  const prioridade = eqFull.prioridadeSetor || "-";
  const equipe = ordem.equipe || eqFull.equipeResponsavel || "-";
  const tecnico = ordem.tecnico || "";

  const dataExecucao = ordem.registradoEm
    ? new Date(ordem.registradoEm).toLocaleDateString("pt-BR")
    : (ordem.dataAgendada ? ordem.dataAgendada.split("-").reverse().join("/") : "____/____/20___");

  const checklistFeito = new Set(ordem.checklist || []);
  const nota = Number(ordem.avaliacaoEstrelas) || 0;
  const estrelasHtml = [1, 2, 3, 4, 5]
    .map((n) => `<span style="color:${n <= nota ? "#163A5B" : "#DCE3EA"}">★</span>`)
    .join("");

  const htmlDoc = `
    <html>
      <head>
        <title>OS PMOC - Patrimônio ${idEquip}</title>
        <style>
          @page { 
            size: A4; 
            margin: 10mm; /* Força o navegador a ignorar margens extras onde aparecem os rodapés */
          }
          * { box-sizing: border-box; }
          body { 
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; 
            color: #1e293b; 
            margin: 0; 
            background: #fff; 
            font-size: 11.5px; 
            line-height: 1.4;
          }
          .os-page { 
            max-width: 800px; 
            margin: 0 auto; 
            padding: 5mm; /* Respiro interno para o conteúdo não colar nas bordas da folha */
          }
          
          .os-topline { 
            display: flex; 
            justify-content: space-between; 
            border-bottom: 1px solid #cbd5e1; 
            padding-bottom: 12px; 
            margin-bottom: 15px; 
          }
          .org { font-size: 14px; font-weight: 700; color: #0f172a; text-transform: uppercase; letter-spacing: 0.5px; }
          .dept { font-size: 10px; color: #64748b; margin-top: 2px; }
          .title-block { text-align: right; }
          .doc-type { font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: 600; }
          .chamado-id { font-family: monospace; font-size: 14px; font-weight: bold; color: #0f172a; }
        
          .os-band { 
            background: #f8fafc; 
            border-left: 3px solid #0f172a;
            padding: 8px 12px; 
            font-weight: 600; 
            margin-bottom: 15px; 
            font-size: 11px;
            color: #334155;
          }
        
          .section-title { 
            font-size: 12px; 
            font-weight: 700; 
            text-transform: uppercase;
            color: #475569;
            border-bottom: 1px solid #f1f5f9; 
            padding-bottom: 4px; 
            margin: 18px 0 10px; 
            letter-spacing: 0.3px;
          }
        
          .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
          .item { background: #fafafa; padding: 6px 8px; border-radius: 4px; border: 1px solid #f1f5f9; }
          .lbl { display: block; font-size: 9px; text-transform: uppercase; color: #64748b; font-weight: 600; }
          .val { font-size: 12px; font-weight: 600; color: #0f172a; margin-top: 2px; }
        
          .checklist { width: 100%; border-collapse: collapse; margin-top: 5px; }
          .checklist th { background: #f8fafc; color: #475569; font-weight: 600; font-size: 10.5px; text-transform: uppercase; }
          .checklist th, .checklist td { border: 1px solid #e2e8f0; padding: 6px 10px; text-align: left; }
          
          .footer-box {
            margin-top: 30px;
            border-top: 1px solid #e2e8f0;
            padding-top: 15px;
            display: flex;
            justify-content: space-between;
            font-size: 11px;
            color: #475569;
          }
        </style>
      </head>
      <body>
        <div class="os-page">

          <div class="os-topline">
            <div>
              <div class="org">Núcleo de Manutenção Predial</div>
              <div class="dept">Controle PMOC</div>
            </div>
            <div class="title-block">
              <div class="doc-type">Ordem de Serviço (PMOC)</div>
              <div class="chamado-id">Patrimônio: ${idEquip}</div>
            </div>
          </div>

          <div class="section-title">1. Dados do Equipamento e Localização</div>
          <div class="grid">
            <div class="item"><span class="lbl">Patrimônio</span><span class="val">${idEquip}</span></div>
            <div class="item"><span class="lbl">Ambiente</span><span class="val">${ambiente}</span></div>
            <div class="item"><span class="lbl">Prioridade do Setor</span><span class="val">${prioridade}</span></div>
            <div class="item"><span class="lbl">Equipe Responsável</span><span class="val">${equipe}</span></div>
            <div class="item"><span class="lbl">Técnico responsável</span><span class="val">${tecnico || "Não informado"}</span></div>
            <div class="item"><span class="lbl">Data de conclusão</span><span class="val">${dataExecucao}</span></div>
          </div>

          <div class="section-title">2. Rotina de Manutenção PMOC — o que foi feito</div>
          <table class="checklist">
            <tr><th style="width: 50px; text-align:center;">OK</th><th>Descrição da Tarefa</th></tr>
            ${CHECKLIST_PREVENTIVA.map((tarefa) => `
              <tr>
                <td style="text-align:center;">${checklistFeito.has(tarefa) ? "✔" : ""}</td>
                <td>${tarefa}</td>
              </tr>
            `).join("")}
          </table>

          <div class="section-title">3. Avaliação do estado da máquina</div>
          <div style="font-size: 18px; letter-spacing: 3px;">${estrelasHtml}</div>

          <div class="section-title">4. Observações e Peças Pendentes</div>
          <div style="border: 1px solid #DCE3EA; height: 50px; background: #F6F8FA;"></div>

          <div style="margin-top: 18px; font-size: 12px; text-align: right; color: #5B6B7A;">
            Técnico(a): ${tecnico || "_______________________"} &nbsp;&nbsp;&nbsp; Assinatura: _______________________
          </div>

        </div>
      </body>
    </html>
  `;

  const janela = window.open('', '', 'width=800,height=600');
  janela.document.write(htmlDoc);
  janela.document.close();

  janela.setTimeout(function() {
    janela.print();
  }, 250);
}

// Apaga TODOS os ciclos (e suas subcoleções) — usado quando um levantamento
// novo é gerado, já que cada levantamento começa do zero (Ciclo 1).
async function apagarTodosOsCiclos() {
  const snap = await getDocs(collection(db, "ciclos"));
  const TAMANHO_LOTE = 400;
  for (const cicloDoc of snap.docs) {
    for (const sub of ["equipamentos", "historico", "ordens"]) {
      const subSnap = await getDocs(collection(db, "ciclos", cicloDoc.id, sub));
      const ids = subSnap.docs.map((d) => d.id);
      for (let inicio = 0; inicio < ids.length; inicio += TAMANHO_LOTE) {
        const batch = writeBatch(db);
        ids.slice(inicio, inicio + TAMANHO_LOTE).forEach((docId) =>
          batch.delete(doc(db, "ciclos", cicloDoc.id, sub, docId))
        );
        await batch.commit();
      }
    }
    await deleteDoc(doc(db, "ciclos", cicloDoc.id));
  }
}

async function deletarCiclo(id) {
  const ok = window.confirm(
    "Excluir este ciclo permanentemente? Isso também apaga os equipamentos, o histórico e as ordens de serviço salvos dentro dele."
  );
  if (!ok) return;
  await registrarAuditoria("Apagar ciclo", `Ciclo ${numeroDoCiclo(id)}`);
  try {
    // Apaga as subcoleções primeiro — apagar o documento do ciclo NÃO apaga
    // o que está dentro dele sozinho, ficaria órfão no Firestore pra sempre.
    for (const sub of ["equipamentos", "historico", "ordens"]) {
      const snap = await getDocs(collection(db, "ciclos", id, sub));
      const ids = snap.docs.map((d) => d.id);
      const TAMANHO_LOTE = 400;
      for (let inicio = 0; inicio < ids.length; inicio += TAMANHO_LOTE) {
        const batch = writeBatch(db);
        ids.slice(inicio, inicio + TAMANHO_LOTE).forEach((docId) =>
          batch.delete(doc(db, "ciclos", id, sub, docId))
        );
        await batch.commit();
      }
    }

    await deleteDoc(doc(db, "ciclos", id));
    toast("Ciclo excluído!");

    // Se apagou o ciclo que estava aberto no momento, troca pra outro válido
    if (id === ESTADO.cicloAtual) {
      await carregarCicloAtual();
      iniciarSincronizacao();
      iniciarSincronizacaoHistorico();
      iniciarSincronizacaoOrdens();
    }
  } catch (err) {
    console.error(err);
    toast("Erro ao excluir ciclo: " + err.message);
  }
}

async function deletarRegistroOrdem(cicloId, id) {
  const ok = window.confirm("Excluir este registro permanentemente?");
  if (!ok) return;
  try {
    await deleteDoc(doc(db, "ciclos", cicloId, "ordens", id));
    toast("Registro excluído!");
  } catch (err) {
    console.error(err);
    toast("Erro ao excluir: " + err.message);
  }
}

async function deletarRegistroHistorico(cicloId, id) {
  const ok = window.confirm("Excluir este registro permanentemente?");
  if (!ok) return;
  try {
    await deleteDoc(doc(db, "ciclos", cicloId, "historico", id));
    toast("Registro excluído!");
  } catch (err) {
    console.error(err);
    toast("Erro ao excluir: " + err.message);
  }
}

async function deletarRegistro(colecao, id) {
  const ok = window.confirm("Excluir este registro permanentemente?");
  if (!ok) return;
  try {
    // Agora ele exclui o item de dentro do ciclo atual!
    await deleteDoc(doc(db, "ciclos", ESTADO.cicloAtual, colecao, id));
    toast("Registro excluído!");
  } catch (err) {
    console.error(err);
    toast("Erro ao excluir: " + err.message);
  }
}

// CONTROLE DO BOTÃO DE REAGENDAR ATRASADOS MANUALMENTE

async function executarReagendamento(btn, textoNormal) {
  btn.disabled = true;
  btn.textContent = "Reagendando...";
  toast("Recalculando rotas e datas. Aguarde...");
  try {
    await reagendarTudo();
    toast("Aparelhos atrasados foram realocados com sucesso!");
    atualizarBannerAtrasados();
  } catch (err) {
    console.error(err);
    toast("Erro ao reagendar: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = textoNormal;
  }
}

const btnReagendar = document.getElementById("btnReagendarAtrasados");
if (btnReagendar) {
  btnReagendar.addEventListener("click", () => executarReagendamento(btnReagendar, "Reagendar Agora"));
}

const btnReagendarCalendario = document.getElementById("btnReagendarCalendario");
if (btnReagendarCalendario) {
  btnReagendarCalendario.addEventListener("click", () => executarReagendamento(btnReagendarCalendario, "↻ Reagendar atrasados"));
}

function numeroDoCiclo(id) {
  const ordenado = [...ESTADO.ciclos].sort((a, b) =>
    String(a.criadoEm || a.dataInicio || "").localeCompare(String(b.criadoEm || b.dataInicio || "")));
  const idx = ordenado.findIndex((c) => c.id === id);
  return idx === -1 ? ordenado.length + 1 : idx + 1;
}

// ------------------------------------------------------------------
// Ciclos de 4 meses — fecha quando todos concluem e reagenda o próximo
// ------------------------------------------------------------------
// ------------------------------------------------------------------
// Ciclos de 4 meses — fecha quando todos concluem e reagenda o próximo
// ------------------------------------------------------------------
function iniciarSincronizacaoCiclos() {
  if (ESTADO.unsubscribeCiclos) ESTADO.unsubscribeCiclos();
  
  const q = query(collection(db, "ciclos"));
  
  ESTADO.unsubscribeCiclos = onSnapshot(q, (snap) => {
    ESTADO.ciclos = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const dataA = a.dataFechamento || a.criadoEm || a.dataInicio || "";
        const dataB = b.dataFechamento || b.criadoEm || b.dataInicio || "";
        return dataB.localeCompare(dataA);
      });
      
    // RASTREADOR: Vai imprimir no console tudo que achou no banco
    console.log(" CICLOS ENCONTRADOS NO BANCO:", ESTADO.ciclos);
    renderCiclos();
  }, (err) => {
    console.error("Erro na busca de ciclos:", err);
    toast("Erro ao ler ciclos: " + err.message);
  });
}

function renderCiclos() {
  const table = $("#ciclosTable");
  if (!table) return;
  
  const encerrados = ESTADO.ciclos.filter(c => c.dataFechamento);
  const ativos = ESTADO.ciclos.filter(c => !c.dataFechamento);

  $("#ciclosCount").textContent = `${encerrados.length} ciclo(s) encerrado(s) | ${ativos.length} ativo(s)`;

  // Adicionamos a coluna "Ações" no cabeçalho
  table.innerHTML = `<thead><tr>
      <th>Ciclo</th><th>Status</th><th>Início</th><th>Encerramento</th><th>Aparelhos</th>
      <th>No prazo</th><th>Em atraso</th><th>Por prédio</th><th>Ações</th>
    </tr></thead><tbody></tbody>`;
  const tbody = table.querySelector("tbody");

  if (!ESTADO.ciclos.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--texto-suave)">Nenhum ciclo encontrado.</td></tr>`;
    return;
  }

  ESTADO.ciclos.forEach((c) => {
    const porPredio = c.porPredio 
      ? Object.entries(c.porPredio).map(([local, qtd]) => `${local}: ${qtd}`).join(" · ")
      : "-";
      
    const isAtivo = !c.dataFechamento;
    const statusLabel = isAtivo 
      ? `<span class="status-select andamento" style="cursor:default">Em andamento</span>` 
      : `<span class="status-select concluido" style="cursor:default">Encerrado</span>`;
    
    const numeroCiclo = numeroDoCiclo(c.id);
    const dataDeInicio = c.dataInicio || (c.criadoEm ? c.criadoEm.split('T')[0] : '');

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>Ciclo ${numeroCiclo}</strong></td>
      <td>${statusLabel}</td>
      <td>${formatarDataBR(dataDeInicio)}</td>
      <td>${c.dataFechamento ? formatarDataBR(c.dataFechamento) : "-"}</td>
      <td>${c.total || ESTADO.equipamentos.length}</td>
      <td>${c.noPrazo !== undefined ? c.noPrazo : "-"}</td>
      <td>${c.emAtraso !== undefined ? c.emAtraso : "-"}</td>
      <td style="font-size:12px;color:var(--texto-suave)">${porPredio}</td>`;
      
    // CRIANDO A COLUNA DE AÇÕES (ABRIR E APAGAR)
    const tdAcoes = document.createElement("td");
    
    const btnLoad = document.createElement("button");
    btnLoad.className = "btn ghost";
    btnLoad.textContent = "Abrir";
    btnLoad.addEventListener("click", () => {
        selecionarCiclo(c.id);
        irParaAba("dashboard"); // Pula direto pro dashboard quando carregar!
    });
    
    const btnDel = document.createElement("button");
    btnDel.className = "btn ghost";
    btnDel.textContent = "Apagar Tudo";
    btnDel.addEventListener("click", () => deletarCiclo(c.id));
    
    tdAcoes.appendChild(btnLoad);
    tdAcoes.appendChild(btnDel);
    tr.appendChild(tdAcoes);

    tbody.appendChild(tr);
  });
}
async function selecionarCiclo(id) {

    ESTADO.cicloAtual = id;

    iniciarSincronizacao();

    iniciarSincronizacaoHistorico();

    iniciarSincronizacaoOrdens();

    toast("Ciclo carregado.");

}

async function verificarFechamentoCiclo() {
  if (ESTADO.fechandoCiclo) return;
  const itens = ESTADO.equipamentos;
  if (!itens.length) return;

  // Só fecha se o ciclo carregado agora for o ATIVO de verdade — sem essa
  // checagem, abrir um ciclo já encerrado (onde todo mundo já está
  // "Concluída") disparava um fechamento novo só de consultar.
  const cicloInfo = ESTADO.ciclos.find((c) => c.id === ESTADO.cicloAtual);
  if (cicloInfo && cicloInfo.dataFechamento) return;

  if (!itens.every((i) => i.statusPreventiva === "Concluída")) return;

  ESTADO.fechandoCiclo = true;
  try {
    await fecharCicloEIniciarProximo();
  } catch (err) {
    console.error(err);
    toast("Erro ao fechar o ciclo: " + err.message);
  } finally {
    ESTADO.fechandoCiclo = false;
  }
}

function ehDiaUtilConfigAtual(data) {
  const diasSemana = (ESTADO.config && ESTADO.config.diasSemana) || 5;
  const DIAS_UTEIS = NOMES_DIAS.slice(0, diasSemana);
  return DIAS_UTEIS.includes(NOMES_DIAS[(data.getDay() + 6) % 7]) && !estaEmFeriado(data);
}

// Percorre, prédio por prédio, do primeiro ao último dia agendado, e aponta
// dias úteis sem nenhum item — normalmente sobra de feriados cadastrados
// depois que cada aparelho já tinha sua próxima data calculada individualmente.
function detectarDiasVaziosNoCronograma(itens) {
  if (!itens.length) return [];

  const porPredio = new Map();
  itens.forEach((item) => {
    const local = item.local || "SEDE";
    if (!porPredio.has(local)) porPredio.set(local, []);
    porPredio.get(local).push(item);
  });

  const diasVazios = [];
  porPredio.forEach((itensDoPredio, local) => {
    const datasComItem = new Set(itensDoPredio.map((i) => i.dataAgendada).filter(Boolean));
    if (datasComItem.size === 0) return;
    const datasOrdenadas = [...datasComItem].sort();
    const [aI, mI, dI] = datasOrdenadas[0].split("-");
    const [aF, mF, dF] = datasOrdenadas[datasOrdenadas.length - 1].split("-");
    const cursor = new Date(aI, parseInt(mI, 10) - 1, dI, 12, 0, 0);
    const fim = new Date(aF, parseInt(mF, 10) - 1, dF, 12, 0, 0);

    while (cursor <= fim) {
      if (ehDiaUtilConfigAtual(cursor) && !datasComItem.has(formatISO(cursor))) {
        diasVazios.push({ local, data: formatISO(cursor) });
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  });

  return diasVazios;
}

// Reorganiza os itens (em memória, ainda não salvos) prédio por prédio,
// preenchendo cada dia útil até a capacidade antes de avançar — igual à
// lógica do gerarCronograma — pra fechar os buracos deixados por feriados.
function compactarCronograma(itens) {
  const capacidades = (ESTADO.config && ESTADO.config.capacidades) || {};

  const primeiraData = itens.reduce((min, i) =>
    (i.dataAgendada && (!min || i.dataAgendada < min)) ? i.dataAgendada : min, null);
  if (!primeiraData) return itens;
  const [aI, mI, dI] = primeiraData.split("-");
  const dataBase = new Date(aI, parseInt(mI, 10) - 1, dI, 12, 0, 0);
  while (!ehDiaUtilConfigAtual(dataBase)) dataBase.setDate(dataBase.getDate() + 1);

  const porPredio = new Map();
  itens.forEach((item) => {
    const local = item.local || "SEDE";
    if (!porPredio.has(local)) porPredio.set(local, []);
    porPredio.get(local).push(item);
  });

  porPredio.forEach((itensDoPredio, local) => {
    const cap = capacidades[local] || { nEquipes: 1, aparelhosDia: 2 };
    const capacidadeDia = Math.max(1, cap.nEquipes) * Math.max(1, cap.aparelhosDia);
    itensDoPredio.sort((a, b) => (a.dataAgendada || "").localeCompare(b.dataAgendada || ""));

    const dataCursor = new Date(dataBase);
    let contador = 0;
    itensDoPredio.forEach((item) => {
      item.dataAgendada = formatISO(dataCursor);
      item.diaPlanejado = NOMES_DIAS[(dataCursor.getDay() + 6) % 7];
      contador++;
      if (contador >= capacidadeDia) {
        contador = 0;
        do { dataCursor.setDate(dataCursor.getDate() + 1); } while (!ehDiaUtilConfigAtual(dataCursor));
      }
    });
  });

  itens.forEach((item) => {
    const [a, m, d] = item.dataAgendada.split("-");
    const dt = new Date(a, parseInt(m, 10) - 1, d, 12, 0, 0);
    const diffDias = Math.floor((dt - dataBase) / 86400000);
    item.semanaPlanejada = `Semana ${Math.max(1, Math.floor(diffDias / 7) + 1)}`;
  });

  itens.sort((a, b) => (a.dataAgendada || "").localeCompare(b.dataAgendada || ""));
  itens.forEach((item, idx) => { item.ordemExecucao = idx + 1; });
  return itens;
}

async function fecharCicloEIniciarProximo() {
  const itens = ESTADO.equipamentos;
  const hojeISO = formatISO(new Date());
  const cicloAntigoId = ESTADO.cicloAtual;

  const porPredio = {};
  let noPrazo = 0, emAtraso = 0;
  itens.forEach((i) => {
    const local = i.local || "SEDE";
    porPredio[local] = (porPredio[local] || 0) + 1;
    const concl = i.dataConclusao || hojeISO;
    if (i.dataAgendada && concl > i.dataAgendada) emAtraso++; else noPrazo++;
  });

  await updateDoc(doc(db, "ciclos", cicloAntigoId), {
    status: "Encerrado", dataFechamento: hojeISO, total: itens.length, noPrazo, emAtraso, porPredio,
  });

  // Usa a próxima data já calculada individualmente pra cada aparelho (na
  // hora que ele foi concluído) — não recalcula tudo em bloco aqui.
  const datasProximas = itens.map((i) => i.proximaPreventiva).filter(Boolean).sort();
  const menorData = datasProximas.length ? datasProximas[0] : hojeISO;

  const novosItens = itens.map((item) => {
    const dataFinal = item.proximaPreventiva || hojeISO;
    const diffDias = Math.floor((new Date(dataFinal) - new Date(menorData)) / 86400000);
    return {
      ...item,
      dataAgendada: dataFinal,
      diaPlanejado: item.proximaPreventivaDia || item.diaPlanejado,
      semanaPlanejada: `Semana ${Math.max(1, Math.floor(diffDias / 7) + 1)}`,
      statusPreventiva: "Pendente",
      dataConclusao: "",
      proximaPreventiva: "",
      proximaPreventivaDia: "",
    };
  });
  novosItens.sort((a, b) => (a.dataAgendada || "").localeCompare(b.dataAgendada || ""));
  novosItens.forEach((item, idx) => { item.ordemExecucao = idx + 1; });

  ESTADO.diasVaziosCronograma = detectarDiasVaziosNoCronograma(novosItens);

  const novoCicloRef = doc(collection(db, "ciclos"));
  await setDoc(novoCicloRef, { criadoEm: new Date().toISOString(), dataInicio: menorData, status: "Ativo" });

  const TAMANHO_LOTE = 400;
  for (let inicio = 0; inicio < novosItens.length; inicio += TAMANHO_LOTE) {
    const pedaco = novosItens.slice(inicio, inicio + TAMANHO_LOTE);
    const batch = writeBatch(db);
    pedaco.forEach((item) => batch.set(doc(db, "ciclos", novoCicloRef.id, "equipamentos", item.id), item));
    await batch.commit();
  }

  ESTADO.cicloAtual = novoCicloRef.id;
  ESTADO.config = { ...(ESTADO.config || {}), dataInicio: menorData };
  await setDoc(doc(db, "config", "cronograma"), ESTADO.config);

  iniciarSincronizacao();
  iniciarSincronizacaoHistorico();
  iniciarSincronizacaoOrdens();

  toast(`Ciclo encerrado! Novo ciclo iniciado com as datas individuais de cada aparelho.`);

  if (ESTADO.diasVaziosCronograma.length > 0) {
    irParaAba("calendar");
  }
}

// Limpar seleção: Ordens
$("#btnLimparSelecaoOrdens")?.addEventListener("click", () => {
  ESTADO.selecaoOrdens.clear();
  
  const checkTodos = $("#checkTodosOrdens");
  if (checkTodos) checkTodos.checked = false;
  
  atualizarBarraSelecao("selecaoOrdens", "selecaoOrdens", "selecaoOrdensTexto");
  renderOrdens(); 
});

// Limpar seleção: Histórico
$("#btnLimparSelecaoHistorico")?.addEventListener("click", () => {
  ESTADO.selecaoHistorico.clear();
  
  const checkTodos = $("#checkTodosHistorico");
  if (checkTodos) checkTodos.checked = false;
  
  atualizarBarraSelecao("selecaoHistorico", "selecaoHistorico", "selecaoHistoricoTexto");
  renderHistorico(); 
});
