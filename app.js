import { db } from "./firebase-config.js?v=2";
import {
  collection, doc, setDoc, getDoc, getDocs, onSnapshot, updateDoc, query, orderBy, writeBatch,
  deleteDoc, addDoc, limit,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";


const PRIORIDADE = {
  "1 - Presidência": 1, "2 - Primeiro Secretário": 2, "3 - Gabinetes": 3,
  "4 - TI/Racks": 4, "5 - Plenário": 5, "6 - Administração": 6, "7 - Todo o resto": 7,
};
const NOMES_DIAS = ["Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo"];
const STATUS_VALIDOS = ["Pendente", "Em andamento", "Concluída"];
const CHAVE_VERIFICACAO_ATRASADOS = "pmokVerificacaoAtrasados";
const MESES_CICLO = 4;

function adicionarMeses(date, meses) {
  const d = new Date(date.getTime());
  const diaOriginal = d.getDate();
  d.setMonth(d.getMonth() + meses);
  // 31/10 + 4 meses cairia em 03/03; volta pro último dia de fevereiro
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
// Um aparelho é considerado atrasado quando a data agendada já passou e ele
// ainda não foi marcado como Concluída.
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
  historico: [],
  chamadosCorretivos: [],
  chamadosCorretivosCarregadosEm: null,
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
};

const URL_CHAMADOS_CORRETIVOS = "https://docs.google.com/spreadsheets/d/e/2PACX-1vR2Ysf9JofZL_2Xn_JPJFaPrMX6IGiwMQWFyhgJcqu8BK_4imC_lmrMgfpDWLnI6MIdcC0OYSDUQFPw/pub?gid=1978174237&single=true&output=csv";
const INTERVALO_ATUALIZACAO_CORRETIVOS_MS = 5 * 60 * 1000; // 5 minutos

const COL_CORRETIVA = {
  DATA: 0, EQUIPE: 1, CHAMADO: 2, ANEXO: 4,
  GABINETE: 6, SALA: 7, NOME_SETOR: 8, SALA_SETOR: 9,
  TOMBO: 12, TAG: 13,
  SEDE: 23, ANEXO1: 24, ANEXO2: 25, ANEXO3: 26, ANEXO4: 27,
  SOLUCIONADO: 28, DESCRICAO_PROBLEMA: 29, PECA_FALTANTE: 30,
};

async function carregarChamadosCorretivos(forcar) {
  const agora = Date.now();
  if (!forcar && ESTADO.chamadosCorretivosCarregadosEm &&
      (agora - ESTADO.chamadosCorretivosCarregadosEm) < INTERVALO_ATUALIZACAO_CORRETIVOS_MS) {
    return;
  }
  try {
    const resp = await fetch(URL_CHAMADOS_CORRETIVOS, { cache: "no-store" });
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
      return {
        data: linha[COL_CORRETIVA.DATA] || "",
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
const $ = (sel) => document.querySelector(sel);
const $all = (sel) => Array.from(document.querySelectorAll(sel));

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2600);
}

$all(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    $all(".tab").forEach((b) => b.classList.remove("active"));
    $all(".view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    $(`#view-${btn.dataset.view}`).classList.add("active");
    if (btn.dataset.view === "calendar") renderCalendar();
    if (btn.dataset.view === "ciclos") renderCiclos();
    if (btn.dataset.view === "dashboard") renderDashboard();
    if (btn.dataset.view === "equipamentos") renderEquipamentosCadastro();
    if (btn.dataset.view === "feriados") renderFeriados();
    if (btn.dataset.view === "ordens") renderOrdens();
    if (btn.dataset.view === "historico") renderHistorico();
    if (btn.dataset.view === "config") renderCapacidadesPorPredio();
  });
});

function irParaAba(nome) {
  $(`.tab[data-view="${nome}"]`)?.click();
}

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
      banner.hidden = true;
    }
  });
}

function atualizarBannerAtrasados() {
  const banner = $("#alertaAtrasados");
  if (!banner) return;
  const atrasados = ESTADO.equipamentos.filter(estaAtrasado);
  if (!atrasados.length) {
    banner.hidden = true;
    return;
  }
  if (banner.dataset.fechado === formatISO(new Date())) return;
  const txt = $("#alertaAtrasadosTexto");
  if (txt) {
    txt.textContent = atrasados.length === 1
      ? "1 aparelho está atrasado."
      : `${atrasados.length} aparelhos estão atrasados.`;
  }
  banner.hidden = false;
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
      classificar(todasAsLinhas);
      $("#dropzoneLabel").textContent =
        `"${file.name}" carregado — ${todasAsLinhas.length} itens em ${wb.SheetNames.length} aba(s)`;
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

  const itens = rows.map((row, idx) => {
    const setor = row[colSetor];
    const ambiente = row[colAmbiente];
    const setorPCM = identificarSetor(setor, ambiente);
    const patrimonio = colPatrimonio ? String(row[colPatrimonio]) : "";
    return {
      id: patrimonio ? `${patrimonio.replace(/[\s/\\"']/g, "_")}_${idx}` : `item_${idx}`,
      patrimonio,
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
  const iso = formatISO(date);
  return ESTADO.feriados.some((f) => iso >= f.dataInicio && iso <= f.dataFim);
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
      let grupoAmbienteAtual = null;
      let indiceGrupo = -1;
      let ordem = 0;

      itensDoPredio.forEach((item) => {
        const chaveAmbiente = `${item.setor}||${item.ambiente}`;
        if (chaveAmbiente !== grupoAmbienteAtual) {
          grupoAmbienteAtual = chaveAmbiente;
          indiceGrupo++;
        }
        item.equipeResponsavel = `Equipe ${(indiceGrupo % cap.nEquipes) + 1}`;

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
async function reagendarTudo() {
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
      (e.statusPreventiva === "Em andamento" && !estaAtrasado(e))
    );
    const pendentes = itensDoPredio
      .filter((e) =>
        e.statusPreventiva === "Pendente" ||
        (e.statusPreventiva === "Em andamento" && estaAtrasado(e))
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
    renderCiclos();
    verificarFechamentoCiclo();
    renderTodosSeletoresLocal();
  }, (err) => {
    console.error(err);
    toast("Erro ao ler dados do Firebase: " + err.message);
  });
}

(async () => {

    await carregarCicloAtual();
    carregarConfig();
    carregarChamadosCorretivos(true);
    setInterval(() => carregarChamadosCorretivos(), INTERVALO_ATUALIZACAO_CORRETIVOS_MS);
    iniciarSincronizacao();
    iniciarSincronizacaoHistorico();
    iniciarSincronizacaoOrdens();
    iniciarSincronizacaoCiclos();

  
    carregarConfig();

})();

function slugLocal(local) {
  return String(local).replace(/[^a-zA-Z0-9]/g, "_");
}

function locaisParaConfigurar() {
  const origem = ESTADO.equipamentos.length ? ESTADO.equipamentos : ESTADO.itensCarregados;
  const set = new Set(origem.map((e) => e.local || "SEDE"));
  return set.size ? [...set].sort() : ["SEDE"];
}

function renderCapacidadesPorPredio() {
  const container = $("#capacidadesPorPredio");
  if (!container) return;
  const locais = locaisParaConfigurar();
  const capacidadesAtuais = (ESTADO.config && ESTADO.config.capacidades) || {};

  container.innerHTML = locais.map((local) => {
    const slug = slugLocal(local);
    const cap = capacidadesAtuais[local] || { nEquipes: 2, aparelhosDia: 2 };
    return `
      <div class="capacidade-linha">
        <span class="capacidade-nome">${local}</span>
        <label>Equipes<input type="number" min="1" id="nEquipes_${slug}" data-local="${local}" class="input-capacidade-equipes" value="${cap.nEquipes}"></label>
        <label>Aparelhos/equipe/dia<input type="number" min="1" id="aparelhosDia_${slug}" data-local="${local}" class="input-capacidade-aparelhos" value="${cap.aparelhosDia}"></label>
      </div>`;
  }).join("");
}

function lerCapacidadesDaTela() {
  const capacidades = {};
  $all(".input-capacidade-equipes").forEach((input) => {
    const local = input.dataset.local;
    const aparInput = $(`#aparelhosDia_${slugLocal(local)}`);
    capacidades[local] = {
      nEquipes: Math.max(1, parseInt(input.value, 10) || 1),
      aparelhosDia: Math.max(1, parseInt(aparInput?.value, 10) || 1),
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
    const el = document.createElement("div");
    el.className = "cal-day" + (itensDoDia.length ? " has-tasks" : "") +
      (ESTADO.diaSelecionado === iso ? " selected" : "") + (feriadoDoDia ? " is-holiday" : "");

    const num = document.createElement("div");
    num.className = "cal-day-num";
    num.textContent = dia;
    el.appendChild(num);

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
    Object.entries(porPredio).forEach(([predio, itensPredio]) => {
      const concluidas = itensPredio.filter((i) => i.statusPreventiva === "Concluída").length;
      const andamento = itensPredio.filter((i) => i.statusPreventiva === "Em andamento").length;
      const temAtrasado = iso < hojeISO && concluidas < itensPredio.length;
      
      const badge = document.createElement("div");
      let classe = "pendente";
      if (concluidas === itensPredio.length) classe = "concluido";
      else if (andamento > 0 || concluidas > 0) classe = "andamento";
      if (temAtrasado) classe = "atrasado";
      
      badge.className = "cal-day-badge " + classe;
      // Agora o texto mostra o nome do anexo antes da quantidade
      badge.textContent = `${predio}: ${itensPredio.length} aparelho${itensPredio.length > 1 ? "s" : ""}`;
      el.appendChild(badge);
    });
    
    el.addEventListener("click", () => selecionarDia(iso));
  }
    grid.appendChild(el);
  }
}

function selecionarDia(iso) {
  ESTADO.diaSelecionado = iso;
  renderCalendar();
  const itensDoDia = aplicarFiltroLocal(ESTADO.equipamentos).filter((i) => i.dataAgendada === iso);
  const [ano, mes, dia] = iso.split("-");
  $("#dayDetailCard").hidden = false;
  $("#dayDetailTitle").textContent = `${dia}/${mes}/${ano} — ${itensDoDia.length} aparelho(s)`;

  const table = $("#dayDetailTable");
  // Adicionada a coluna "Prédio" aqui:
  table.innerHTML = `<thead><tr><th>Patrimônio</th><th>Prédio</th><th>Setor</th><th>Ambiente</th><th>Equipe</th><th>Status</th></tr></thead><tbody></tbody>`;
  const tbody = table.querySelector("tbody");

  itensDoDia.forEach((item) => {
    const tr = document.createElement("tr");
    // E inserido o item.local na tabela:
    tr.innerHTML = `<td>${item.patrimonio || "-"}</td><td>${item.local || "SEDE"}</td><td>${item.setor}</td><td>${item.ambiente}</td><td>${item.equipeResponsavel}</td>`;
    const tdStatus = document.createElement("td");
    const select = document.createElement("select");
    select.className = "status-select " + classeStatus(item.statusPreventiva);
    STATUS_VALIDOS.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s; opt.textContent = s;
      if (s === item.statusPreventiva) opt.selected = true;
      select.appendChild(opt);
    });

    select.addEventListener("change", async () => {
      const statusAnterior = item.statusPreventiva;
      const statusNovo = select.value;

      select.disabled = true;

      try {
        const camposStatus = {
          statusPreventiva: statusNovo,
          dataConclusao: statusNovo === "Concluída" ? formatISO(new Date()) : "",
        };
        await updateDoc(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", item.id), camposStatus);
        item.statusPreventiva = statusNovo;
        item.dataConclusao = camposStatus.dataConclusao;
        
        const promessasLogs = [registrarHistorico(item, statusAnterior, statusNovo)];
        
        if (statusNovo === "Concluída") {
          promessasLogs.push(registrarOrdemServico(item));
        } else if (statusAnterior === "Concluída" && statusNovo !== "Concluída") {
          promessasLogs.push(removerOrdemServico(item.id));
        }

        await Promise.all(promessasLogs);

        select.className = "status-select " + classeStatus(statusNovo);
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

    if (estaAtrasado(item)) {
      const tagAtraso = document.createElement("span");
      tagAtraso.className = "status-select atrasado";
      tagAtraso.style.marginLeft = "6px";
      tagAtraso.textContent = "Atrasado";
      tdStatus.appendChild(tagAtraso);
    }

    tr.appendChild(tdStatus);
    tbody.appendChild(tr);
  });
}

function classeStatus(status) {
  if (status === "Concluída") return "concluido";
  if (status === "Em andamento") return "andamento";
  return "pendente";
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
}

async function registrarHistorico(item, statusAnterior, statusNovo) {
  const agora = new Date();
  await addDoc(collection(     db,     "ciclos",     ESTADO.cicloAtual,     "historico" ), {
    equipamentoId: item.id,
    patrimonio: item.patrimonio || "",
    setor: item.setor || "",
    ambiente: item.ambiente || "",
    local: item.local || "SEDE",
    equipe: item.equipeResponsavel || "",
    tipo: "Preventiva",
    statusAnterior: statusAnterior || "Pendente",
    statusNovo: statusNovo,
    registradoEm: agora.toISOString()
  });
}

async function registrarOrdemServico(item) {
  const agora = new Date();
  
  const ordensAntigas = ESTADO.ordens.filter(o => o.equipamentoId === item.id);
  if (ordensAntigas.length > 0) {
    const batch = writeBatch(db);
    ordensAntigas.forEach(o => batch.delete(doc(db, "ciclos", ESTADO.cicloAtual, "ordens", o.id)));
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
  });
}

async function removerOrdemServico(equipamentoId) {
  const ordensDoEquipamento = ESTADO.ordens.filter(o => o.equipamentoId === equipamentoId);
  if (ordensDoEquipamento.length > 0) {
    const batch = writeBatch(db);
    ordensDoEquipamento.forEach(o => batch.delete(doc(db, "ciclos", ESTADO.cicloAtual, "ordens", o.id)));
    await batch.commit();
  }
}

function iniciarSincronizacaoOrdens() {
  if (!ESTADO.cicloAtual) return; // <-- TRAVA DE SEGURANÇA ADICIONADA AQUI
  if (ESTADO.unsubscribeOrdens) ESTADO.unsubscribeOrdens();
  const q = query(collection(db, "ciclos", ESTADO.cicloAtual, "ordens" ), orderBy("registradoEm", "desc"), limit(300));
  ESTADO.unsubscribeOrdens = onSnapshot(q, (snap) => {
    ESTADO.ordens = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderOrdens();
  }, (err) => {
    console.error(err);
    toast("Erro ao ler ordens de serviço: " + err.message);
  });
}
// APAGUEI A CHAMADA SOLTA QUE FICAVA AQUI EMBAIXO
iniciarSincronizacaoOrdens();

function iniciarSincronizacaoHistorico(){
  if (!ESTADO.cicloAtual) return; // Trava de segurança
  if(ESTADO.unsubscribeHistorico) ESTADO.unsubscribeHistorico();
  const q = query(collection(db, "ciclos", ESTADO.cicloAtual, "historico"), orderBy("registradoEm","desc"));

  ESTADO.unsubscribeHistorico = onSnapshot(q, (snap) => {
    ESTADO.historico = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data()
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

  table.innerHTML = `<thead><tr>
      <th>Data/Hora</th><th>Patrimônio</th><th>Setor</th>
      <th>Equipe</th><th>Tipo</th><th>De</th><th>Para</th><th>Ações</th>
  </tr></thead><tbody></tbody>`;

  const tbody = table.querySelector("tbody");

  historico.forEach(h => {
    const tr = document.createElement("tr");
    const ehReagendamento = h.tipo === "Atraso Reagendado";
    const colDe = ehReagendamento
      ? `<td>${formatarDataBR(h.dataAnterior)}</td>`
      : `<td><span class="status-select ${classeStatus(h.statusAnterior)}">${h.statusAnterior || "-"}</span></td>`;
    const colPara = ehReagendamento
      ? `<td>${formatarDataBR(h.dataNova)}</td>`
      : `<td><span class="status-select ${classeStatus(h.statusNovo)}">${h.statusNovo}</span></td>`;
    tr.innerHTML = `
        <td>${new Date(h.registradoEm).toLocaleString("pt-BR")}</td>
        <td>${h.patrimonio || "-"}</td>
        <td>${h.setor}</td>
        <td>${h.equipe}</td>
        <td>${h.tipo || "Preventiva"}</td>
        ${colDe}
        ${colPara}
    `;

    const tdAcao = document.createElement("td");
    const btnDel = document.createElement("button");
    btnDel.className = "btn ghost";
    btnDel.textContent = "🗑️";
    btnDel.addEventListener("click", () => deletarRegistro('historico', h.id));
    tdAcao.appendChild(btnDel);
    tr.appendChild(tdAcao);
    tbody.appendChild(tr);
  });
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
      <th>Data de Conclusão</th><th>Patrimônio</th><th>Setor</th><th>Ambiente</th>
      <th>Equipe</th><th>Ações</th>
    </tr></thead><tbody></tbody>`;

  const tbody = table.querySelector("tbody");

  ordens.forEach((o) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${new Date(o.registradoEm).toLocaleString("pt-BR")}</td>
      <td>${o.patrimonio || "-"}</td>
      <td>${o.setor || ""}</td>
      <td>${o.ambiente || ""}</td>
      <td>${o.equipe || ""}</td>
    `;

    const tdBtn = document.createElement("td");

    const btnPrint = document.createElement("button");
    btnPrint.className = "btn ghost";
    btnPrint.textContent = "🖨️ PMOC";
    btnPrint.addEventListener("click", () => gerarPDFPMOC(o));

    const btnDel = document.createElement("button");
    btnDel.className = "btn ghost";
    btnDel.textContent = "🗑️";
    btnDel.addEventListener("click", () => deletarRegistro('ordens', o.id));

    tdBtn.appendChild(btnPrint);
    tdBtn.appendChild(btnDel);
    tr.appendChild(tdBtn);
    tbody.appendChild(tr);
  });
}

const btnAdicionarEquipamento = $("#btnAdicionarEquipamento");
if (btnAdicionarEquipamento) {
  btnAdicionarEquipamento.addEventListener("click", adicionarEquipamentoManual);
}

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

async function adicionarEquipamentoManual() {
  const patrimonio = $("#eqPatrimonio").value.trim();
  const setor = $("#eqSetor").value.trim();
  const ambiente = $("#eqAmbiente").value.trim();

  if (!setor || !ambiente) {
    toast("Preencha pelo menos Setor e Ambiente.");
    return;
  }

  const setorPCM = identificarSetor(setor, ambiente);
  const prioridadeSetor = PRIORIDADE[setorPCM] || 7;
  const pisoPCM = descobrirPiso(setor);

  if (idEquipamentoEmEdicao) {
    const local = $("#eqLocal")?.value || "SEDE";
    try {
      await updateDoc(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", idEquipamentoEmEdicao), {
        patrimonio, setor, ambiente, local, setorPCM, prioridadeSetor, pisoPCM
      });
      toast("Equipamento atualizado com sucesso!");
      idEquipamentoEmEdicao = null;
      if (btnAdicionarEquipamento) btnAdicionarEquipamento.textContent = "Adicionar Equipamento";
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
    const capLocal = (ESTADO.config && ESTADO.config.capacidades && ESTADO.config.capacidades[local]) || { nEquipes: 2 };
    const equipeResponsavel = `Equipe ${((ordemExecucao - 1) % capLocal.nEquipes) + 1}`;

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

function renderEquipamentosCadastro() {
  const table = $("#equipamentosTable");
  if (!table) return;

  const termo = ESTADO.filtros.equipamentos;
  const itens = aplicarFiltroLocal(ESTADO.equipamentos).filter((item) => {
    if (!termo) return true;
    const alvo = `${item.patrimonio || ""} ${item.setor || ""} ${item.ambiente || ""} ${item.setorPCM || ""}`.toLowerCase();
    return alvo.includes(termo);
  });

  $("#equipamentosCount").textContent = `${itens.length} itens`;
  table.innerHTML = `<thead><tr>
      <th>Patrimônio</th><th>Setor</th><th>Ambiente</th><th>Prédio</th><th>Setor PCM</th>
      <th>Status</th><th>Origem</th><th></th>
    </tr></thead><tbody></tbody>`;
  const tbody = table.querySelector("tbody");

  itens.forEach((item) => {
    const tr = document.createElement("tr");
    tr.className = "linha-clicavel";
    tr.innerHTML = `<td>${item.patrimonio || "-"}</td><td>${item.setor}</td><td>${item.ambiente}</td>
      <td>${item.local || "SEDE"}</td>
      <td>${item.setorPCM}</td>
      <td>
        <span class="status-select ${classeStatus(item.statusPreventiva)}" style="cursor:default">${item.statusPreventiva}</span>
        ${estaAtrasado(item) ? '<span class="status-select atrasado" style="margin-left:6px;cursor:default">Atrasado</span>' : ""}
      </td>
      <td>${item.origem === "manual" ? "Manual" : "Planilha"}</td>`;

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

    tr.addEventListener("click", () => abrirDrawerEquipamento(item.id));
    tbody.appendChild(tr);
  });
}

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

async function abrirDrawerEquipamento(id) {   await carregarChamadosCorretivos();
  const item = ESTADO.equipamentos.find((e) => e.id === id);
  if (!item) return;

  // Última preventiva concluída deste aparelho, a partir do histórico
  const conclusoes = ESTADO.historico
    .filter((h) => h.equipamentoId === id && h.statusNovo === "Concluída")
    .sort((a, b) => String(b.registradoEm).localeCompare(String(a.registradoEm)));
  const ultimaPreventiva = conclusoes.length
    ? new Date(conclusoes[0].registradoEm).toLocaleString("pt-BR")
    : "Nunca registrada";

  const totalPreventivas = conclusoes.length;
  const { exatos, aproximados } = chamadosDoEquipamento(item);
  const linhaChamado = (c) =>
    `<div class="drawer-campo"><span class="rotulo">${c.data || "-"}</span>
     <span class="valor">${c.solucionado || "-"} — ${c.descricaoProblema || c.pecaFaltante || "sem descrição"} (${c.equipe || "-"})</span></div>`;

  $("#drawerTitulo").textContent = item.patrimonio ? `Patrimônio ${item.patrimonio}` : item.ambiente;

  $("#drawerCorpo").innerHTML = `
    <details class="drawer-secao" open>
      <summary>Situação</summary>
      <div class="drawer-campo"><span class="rotulo">Status</span>
        <span class="valor"><span class="status-select ${classeStatus(item.statusPreventiva)}" style="cursor:default">${item.statusPreventiva}</span>
        ${estaAtrasado(item) ? '<span class="status-select atrasado" style="margin-left:6px;cursor:default">Atrasado</span>' : ""}</span></div>
      <div class="drawer-campo"><span class="rotulo">Próxima preventiva</span><span class="valor">${formatarDataBR(item.dataAgendada)} ${item.diaPlanejado ? "(" + item.diaPlanejado + ")" : ""}</span></div>
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

    <details class="drawer-secao drawer-form">
      <summary>Editar cadastro</summary>
      <label>Patrimônio<input type="text" id="drawerPatrimonio" value="${item.patrimonio || ""}"></label>
      <label>Setor<input type="text" id="drawerSetor" value="${item.setor || ""}"></label>
      <label>Ambiente<input type="text" id="drawerAmbiente" value="${item.ambiente || ""}"></label>
      <label>Prédio
        <select id="drawerLocal">
          ${["SEDE", "ANEXO 1", "ANEXO 2", "ANEXO 3", "ANEXO 4"].map((l) =>
            `<option value="${l}" ${(item.local || "SEDE") === l ? "selected" : ""}>${l}</option>`).join("")}
        </select>
      </label>
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
      <summary style="color:var(--vermelho)">Zona de risco</summary>
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
    if (!setor || !ambiente) {
      toast("Preencha pelo menos Setor e Ambiente.");
      return;
    }
    const setorPCM = identificarSetor(setor, ambiente);
    try {
      await updateDoc(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", id), {
        patrimonio, setor, ambiente, local, setorPCM,
        prioridadeSetor: PRIORIDADE[setorPCM] || 7,
        pisoPCM: descobrirPiso(setor),
      });
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
      });
      await addDoc(collection(     db,     "ciclos",     ESTADO.cicloAtual,     "historico" ), {
        equipamentoId: id,
        patrimonio: item.patrimonio || "",
        setor: item.setor || "",
        ambiente: item.ambiente || "",
        local: item.local || "SEDE",
        equipe: item.equipeResponsavel || "",
        tipo: "Reagendamento manual",
        dataAnterior: item.dataAgendada || "",
        dataNova: novaData,
        registradoEm: new Date().toISOString(),
      });
      toast(`Reagendado para ${formatarDataBR(novaData)}.`);
      fecharDrawer();
    } catch (err) {
      console.error(err);
      toast("Erro ao reagendar: " + err.message);
    }
  });

  $("#drawerExcluir").addEventListener("click", async () => {
    const ok = window.confirm(`Remover "${item.patrimonio || item.ambiente}"? Essa ação não pode ser desfeita.`);
    if (!ok) return;
    try {
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
    ESTADO.feriados.push({ id: refDoc.id, ...novoFeriado });
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
    toast("Removido. Reorganizando cronograma...");
    await reagendarTudo();
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

    renderCalendar();
    renderDashboard();
    atualizarBannerAtrasados();

    toast(`Cronograma apagado (${ids.length} itens removidos).`);
  } catch (err) {
    console.error(err);
    toast("Erro ao apagar cronograma: " + err.message);
  } finally {
    btnApagarCronograma.disabled = false;
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
  btnLimparHistorico.addEventListener("click", () => {
    apagarColecaoCompleta(
      "historico",
      "Isso vai apagar TODO o histórico de manutenção, permanentemente. Continuar?"
    );
  });
}

const btnLimparOrdens = $("#btnLimparOrdens");
if (btnLimparOrdens) {
  btnLimparOrdens.addEventListener("click", () => {
    apagarColecaoCompleta(
      "ordens",
      "Isso vai apagar TODAS as ordens de serviço emitidas, permanentemente. Continuar?"
    );
  });
}

function gerarPDFPMOC(ordem) {
  const eqFull = ESTADO.equipamentos.find(e => e.id === ordem.equipamentoId) || {};

  const idEquip = eqFull.patrimonio || ordem.patrimonio || "Sem Patrimônio";
  const setor = eqFull.setorPCM || ordem.setor || "Não informado";
  const ambiente = eqFull.ambiente || ordem.ambiente || "-";
  const prioridade = eqFull.prioridadeSetor || "-";
  const equipe = ordem.equipe || eqFull.equipeResponsavel || "-";

  const dataExecucao = ordem.dataAgendada ? ordem.dataAgendada.split("-").reverse().join("/") : "____/____/20___";

  const htmlDoc = `
    <html>
      <head>
        <title>OS PMOC - Patrimônio ${idEquip}</title>
        <style>
          body { font-family: "Segoe UI", Roboto, sans-serif; color: #1C2530; margin: 0; background: #fff; }
          .os-page { padding: 20mm; max-width: 800px; margin: 0 auto; }
          .os-topline { display: flex; justify-content: space-between; border-bottom: 2px solid #1C2530; padding-bottom: 15px; margin-bottom: 20px; }
          .org { font-family: Georgia, serif; font-size: 18px; font-weight: bold; }
          .dept { font-size: 11px; color: #5B6B7A; }
          .title-block { text-align: right; }
          .doc-type { font-family: Georgia, serif; font-size: 14px; font-style: italic; color: #5B6B7A; }
          .chamado-id { font-family: Consolas, monospace; font-size: 18px; font-weight: bold; color: #163A5B; }
          .os-band { background: #EEF3F8; padding: 12px 16px; font-weight: bold; margin-bottom: 25px; }
          .section-title { font-family: Georgia, serif; font-size: 15px; font-weight: bold; border-bottom: 1px solid #DCE3EA; padding-bottom: 5px; margin: 25px 0 15px; }
          .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
          .item { border-bottom: 1px dotted #DCE3EA; padding-bottom: 5px; }
          .lbl { display: block; font-size: 10px; text-transform: uppercase; color: #5B6B7A; }
          .val { font-size: 15px; font-weight: 500; }
          .checklist { width: 100%; border-collapse: collapse; margin-top: 10px; }
          .checklist th, .checklist td { border: 1px solid #DCE3EA; padding: 10px; font-size: 13px; text-align: left; }
          .checkbox-box { width: 16px; height: 16px; border: 1px solid #1C2530; display: inline-block; }
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

          <div class="os-band">Rotina PMOC Mensal — ${setor}</div>

          <div class="section-title">1. Dados do Equipamento e Localização</div>
          <div class="grid">
            <div class="item"><span class="lbl">Patrimônio</span><span class="val">${idEquip}</span></div>
            <div class="item"><span class="lbl">Ambiente</span><span class="val">${ambiente}</span></div>
            <div class="item"><span class="lbl">Prioridade do Setor</span><span class="val">${prioridade}</span></div>
            <div class="item"><span class="lbl">Equipe Responsável</span><span class="val">${equipe}</span></div>
          </div>

          <div class="section-title">2. Rotina de Manutenção PMOC</div>
          <table class="checklist">
            <tr><th style="width: 50px; text-align:center;">OK</th><th>Descrição da Tarefa</th></tr>
            <tr><td style="text-align:center;"><span class="checkbox-box"></span></td><td>Limpeza dos filtros de ar e grelhas.</td></tr>
            <tr><td style="text-align:center;"><span class="checkbox-box"></span></td><td>Higienização da bandeja e desobstrução de dreno.</td></tr>
            <tr><td style="text-align:center;"><span class="checkbox-box"></span></td><td>Verificação de ruídos e vibrações.</td></tr>
            <tr><td style="text-align:center;"><span class="checkbox-box"></span></td><td>Medição de temperatura de insuflamento e retorno.</td></tr>
          </table>

          <div class="section-title" style="margin-top: 40px;">3. Observações e Peças Pendentes</div>
          <div style="border: 1px solid #DCE3EA; height: 120px; background: #F6F8FA;"></div>

          <div style="margin-top: 40px; font-size: 14px; text-align: right; color: #5B6B7A;">
            Data: ${dataExecucao} &nbsp;&nbsp;&nbsp; Técnico(a): _______________________
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

const btnReagendar = document.getElementById("btnReagendarAtrasados");

if (btnReagendar) {
  btnReagendar.addEventListener("click", async () => {
    // Desabilita o botão para evitar múltiplos cliques
    btnReagendar.disabled = true;
    btnReagendar.textContent = "Reagendando...";
    toast("Recalculando rotas e datas. Aguarde...");
    
    try {
      await reagendarTudo();
      toast("Aparelhos atrasados foram realocados com sucesso!");
      
      // Esconde a faixa amarela já que o problema foi resolvido
      const banner = document.getElementById("alertaAtrasados");
      if (banner) banner.hidden = true;
      
    } catch (err) {
      console.error(err);
      toast("Erro ao reagendar: " + err.message);
    } finally {
      // Volta o botão ao normal
      btnReagendar.disabled = false;
      btnReagendar.textContent = "Reagendar Agora";
    }
  });
}

console.log("Botão histórico:", $("#btnLimparHistorico"));
console.log("Botão ordens:", $("#btnLimparOrdens"));

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

async function fecharCicloEIniciarProximo() {
  const itens = ESTADO.equipamentos;
  const hojeISO = formatISO(new Date());
  const cicloAntigoId = ESTADO.cicloAtual;

  // 1. Calcula os números do ciclo que está fechando
  const porPredio = {};
  let noPrazo = 0, emAtraso = 0;
  itens.forEach((i) => {
    const local = i.local || "SEDE";
    porPredio[local] = (porPredio[local] || 0) + 1;
    const concl = i.dataConclusao || hojeISO;
    if (i.dataAgendada && concl > i.dataAgendada) emAtraso++; else noPrazo++;
  });

  // 2. Marca a gaveta ATUAL como encerrada
  await updateDoc(doc(db, "ciclos", cicloAntigoId), {
    status: "Encerrado",
    dataFechamento: hojeISO,
    total: itens.length,
    noPrazo,
    emAtraso,
    porPredio,
  });

  // 3. Data-base do PRÓXIMO ciclo: a PRIMEIRA conclusão registrada neste
  // ciclo + 4 meses. Todos os aparelhos usam essa mesma data-base — o ritmo
  // de 4 em 4 meses é do ciclo inteiro, não de cada aparelho individualmente.
  const datasAgendadas = itens.map((i) => i.dataAgendada).filter(Boolean).sort();
  const primeiraData = datasAgendadas.length ? datasAgendadas[0] : hojeISO;
  const [pa, pm, pd] = primeiraData.split("-");
  const dataBaseProximoCiclo = adicionarMeses(new Date(pa, parseInt(pm, 10) - 1, pd, 12, 0, 0), MESES_CICLO);

  const diasSemana = (ESTADO.config && ESTADO.config.diasSemana) || 5;
  const capacidades = (ESTADO.config && ESTADO.config.capacidades) || {};
  const DIAS_UTEIS = NOMES_DIAS.slice(0, diasSemana);
  const ehDiaUtilLocal = (dt) =>
    DIAS_UTEIS.includes(NOMES_DIAS[(dt.getDay() + 6) % 7]) && !estaEmFeriado(dt);

  const porPredioItens = new Map();
  itens.forEach((i) => {
    const local = i.local || "SEDE";
    if (!porPredioItens.has(local)) porPredioItens.set(local, []);
    porPredioItens.get(local).push(i);
  });

  const novosItens = [];
  let menorDataNova = null;

  // 4. Empacota por prédio a partir da mesma data-base, respeitando
  // capacidade e feriados (mesmo esquema usado no gerarCronograma original)
  porPredioItens.forEach((itensDoPredio, local) => {
    const cap = capacidades[local] || { nEquipes: 1, aparelhosDia: 2 };
    const capacidadeDia = Math.max(1, cap.nEquipes) * Math.max(1, cap.aparelhosDia);

    let cursor = new Date(dataBaseProximoCiclo.getTime());
    while (!ehDiaUtilLocal(cursor)) cursor.setDate(cursor.getDate() + 1);

    let contador = 0;
    const itensOrdenados = [...itensDoPredio].sort(
      (a, b) => (a.ordemExecucao || 0) - (b.ordemExecucao || 0)
    );

    itensOrdenados.forEach((item) => {
      const novaData = formatISO(cursor);
      if (!menorDataNova || novaData < menorDataNova) menorDataNova = novaData;

      novosItens.push({
        ...item,
        dataAgendada: novaData,
        diaPlanejado: NOMES_DIAS[(cursor.getDay() + 6) % 7],
        statusPreventiva: "Pendente",
        dataConclusao: "",
      });

      contador++;
      if (contador >= capacidadeDia) {
        contador = 0;
        do { cursor.setDate(cursor.getDate() + 1); } while (!ehDiaUtilLocal(cursor));
      }
    });
  });

  novosItens.forEach((item, idx) => { item.ordemExecucao = idx + 1; });

  // 5. Cria a gaveta NOVA e migra os aparelhos reagendados pra ela
  const novoCicloRef = doc(collection(db, "ciclos"));
  await setDoc(novoCicloRef, {
    criadoEm: new Date().toISOString(),
    dataInicio: menorDataNova || hojeISO,
    status: "Ativo",
  });

  const TAMANHO_LOTE = 400;
  for (let inicio = 0; inicio < novosItens.length; inicio += TAMANHO_LOTE) {
    const pedaco = novosItens.slice(inicio, inicio + TAMANHO_LOTE);
    const batch = writeBatch(db);
    pedaco.forEach((item) => batch.set(doc(db, "ciclos", novoCicloRef.id, "equipamentos", item.id), item));
    await batch.commit();
  }

  ESTADO.cicloAtual = novoCicloRef.id;
  ESTADO.config = { ...(ESTADO.config || {}), dataInicio: menorDataNova || hojeISO };
  await setDoc(doc(db, "config", "cronograma"), ESTADO.config);

  iniciarSincronizacao();
  iniciarSincronizacaoHistorico();
  iniciarSincronizacaoOrdens();

  toast(`Ciclo encerrado! Novo ciclo agendado a partir de ${formatarDataBR(menorDataNova)}.`);
}
