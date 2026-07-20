import { db } from "./firebase-config.js";
import {
  collection, doc, setDoc, getDocs, onSnapshot, updateDoc, query, orderBy, writeBatch,
  deleteDoc, addDoc, limit,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const PRIORIDADE = {
  "1 - Presidência": 1, "2 - Primeiro Secretário": 2, "3 - Gabinetes": 3,
  "4 - TI/Racks": 4, "5 - Plenário": 5, "6 - Administração": 6, "7 - Todo o resto": 7,
};
const NOMES_DIAS = ["Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo"];
const STATUS_VALIDOS = ["Pendente", "Em andamento", "Concluída"];

// Controle de estado para edição de itens
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

// ---------------------------------------------------------------------------
// Estado da aplicação
// ---------------------------------------------------------------------------
const ESTADO = {
  meta: null,
  itensCarregados: [],
  equipamentos: [],
  feriados: [],
  ordens: [],
  historico: [],
  unsubscribe: null,
  unsubscribeFeriados: null,
  unsubscribeOrdens: null,
  unsubscribeHistorico: null,
  calYear: null,
  calMonth: null,
  diaSelecionado: null,
};

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
    if (btn.dataset.view === "dashboard") renderDashboard();
    if (btn.dataset.view === "equipamentos") renderEquipamentosCadastro();
    if (btn.dataset.view === "feriados") renderFeriados();
    if (btn.dataset.view === "ordens") renderOrdens();
  });
});

function irParaAba(nome) {
  $(`.tab[data-view="${nome}"]`)?.click();
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
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      if (!rows.length) throw new Error("Planilha vazia.");
      classificar(rows);
      $("#dropzoneLabel").textContent = `"${file.name}" carregado — ${rows.length} itens`;
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
  let linhasCorrigidas = 0;
  rows.forEach((row) => {
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

// ---------------------------------------------------------------------------
// Feriados e férias — datas que o cronograma deve pular
// ---------------------------------------------------------------------------
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
  
  const nEquipes = Math.max(1, parseInt($("#nEquipes")?.value, 10) || 1);
  const aparelhosDia = Math.max(1, parseInt($("#aparelhosDia")?.value, 10) || 1);
  const diasSemana = Math.min(7, Math.max(1, parseInt($("#diasSemana")?.value, 10) || 5));
  const dataInicioStr = $("#dataInicio")?.value;
  
  if (!dataInicioStr) {
    toast("Escolha a data de início do cronograma.");
    return;
  }

  const DIAS_UTEIS = NOMES_DIAS.slice(0, diasSemana);
  const capacidadeDia = nEquipes * aparelhosDia;

  function ehDiaUtil(data) {
    return DIAS_UTEIS.includes(NOMES_DIAS[(data.getDay() + 6) % 7]) && !estaEmFeriado(data);
  }

  const [ano, mes, dia] = dataInicioStr.split("-");
  let dataCursor = new Date(ano, parseInt(mes, 10) - 1, dia, 12, 0, 0); 

  while (!ehDiaUtil(dataCursor)) {
    dataCursor.setDate(dataCursor.getDate() + 1);
  }
  const primeiraDataUtil = new Date(dataCursor);

  $("#btnGerar").disabled = true;
  try {
    const itensPlanilha = ESTADO.itensCarregados.map((i) => ({ ...i }));

    toast("Lendo dados anteriores...");
    
    const existentes = {};
    const idsAntigos = [];
    const manuaisPreservados = [];
    
    ESTADO.equipamentos.forEach((dados) => {
      existentes[dados.id] = dados;
      idsAntigos.push(dados.id);
      if (dados.origem === "manual") {
        manuaisPreservados.push({ ...dados });
      }
    });

    const itens = [...itensPlanilha, ...manuaisPreservados];

    let contador = 0;
    let grupoAmbienteAtual = null;
    let indiceGrupo = -1;
    let ordem = 0;
    
    itens.forEach((item) => {
      const chaveAmbiente = `${item.setor}||${item.ambiente}`;
      if (chaveAmbiente !== grupoAmbienteAtual) {
        grupoAmbienteAtual = chaveAmbiente;
        indiceGrupo++;
      }
      item.equipeResponsavel = `Equipe ${(indiceGrupo % nEquipes) + 1}`;

      ordem++;
      item.ordemExecucao = ordem;
      item.dataAgendada = formatISO(dataCursor);
      item.diaPlanejado = NOMES_DIAS[(dataCursor.getDay() + 6) % 7];
      const diffDias = Math.floor((dataCursor - primeiraDataUtil) / 86400000);
      item.semanaPlanejada = `Semana ${Math.floor(diffDias / 7) + 1}`;

      const anterior = existentes[item.id];
      if (anterior) {
        item.statusPreventiva = anterior.statusPreventiva || "Pendente";
        item.observacao = anterior.observacao || "";
      }

      contador++;
      if (contador >= capacidadeDia) {
        contador = 0;
        do {
          dataCursor.setDate(dataCursor.getDate() + 1);
        } while (!ehDiaUtil(dataCursor));
      }
    });

    const diasNecessarios = Math.ceil(itens.length / capacidadeDia);
    const semanasNecessarias = Math.ceil(diasNecessarios / diasSemana);
    $("#resumoCapacidade").textContent =
      `Capacidade diária: ${capacidadeDia} aparelhos · Dias necessários: ${diasNecessarios} · ` +
      `Semanas necessárias: ${semanasNecessarias}` +
      (manuaisPreservados.length ? ` · ${manuaisPreservados.length} cadastrado(s) manualmente incluído(s)` : "");

    const TAMANHO_LOTE = 400;

    if (idsAntigos.length) {
      toast("Limpando dados antigos...");
      for (let inicio = 0; inicio < idsAntigos.length; inicio += TAMANHO_LOTE) {
        const pedacoIds = idsAntigos.slice(inicio, inicio + TAMANHO_LOTE);
        const batchDel = writeBatch(db);
        pedacoIds.forEach((id) => batchDel.delete(doc(db, "equipamentos", id)));
        await batchDel.commit();
      }
    }

    for (let inicio = 0; inicio < itens.length; inicio += TAMANHO_LOTE) {
      const pedaco = itens.slice(inicio, inicio + TAMANHO_LOTE);
      const batch = writeBatch(db);
      pedaco.forEach((item) => batch.set(doc(db, "equipamentos", item.id), item));
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

function iniciarSincronizacao() {
  if (ESTADO.unsubscribe) ESTADO.unsubscribe();
  const q = query(collection(db, "equipamentos"), orderBy("ordemExecucao"));
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
  }, (err) => {
    console.error(err);
    toast("Erro ao ler dados do Firebase: " + err.message);
  });
}

iniciarSincronizacao();
iniciarSincronizacaoHistorico();

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

  const porData = {};
  for (const item of ESTADO.equipamentos) {
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
      const concluidas = itensDoDia.filter((i) => i.statusPreventiva === "Concluída").length;
      const andamento = itensDoDia.filter((i) => i.statusPreventiva === "Em andamento").length;
      const badge = document.createElement("div");
      let classe = "pendente";
      if (concluidas === itensDoDia.length) classe = "concluido";
      else if (andamento > 0 || concluidas > 0) classe = "andamento";
      badge.className = "cal-day-badge " + classe;
      badge.textContent = `${itensDoDia.length} aparelho${itensDoDia.length > 1 ? "s" : ""}`;
      el.appendChild(badge);
      el.addEventListener("click", () => selecionarDia(iso));
    }
    grid.appendChild(el);
  }
}

function selecionarDia(iso) {
  ESTADO.diaSelecionado = iso;
  renderCalendar();
  const itensDoDia = ESTADO.equipamentos.filter((i) => i.dataAgendada === iso);
  const [ano, mes, dia] = iso.split("-");
  $("#dayDetailCard").hidden = false;
  $("#dayDetailTitle").textContent = `${dia}/${mes}/${ano} — ${itensDoDia.length} aparelho(s)`;

  const table = $("#dayDetailTable");
  table.innerHTML = `<thead><tr><th>Patrimônio</th><th>Setor</th><th>Ambiente</th><th>Equipe</th><th>Status</th></tr></thead><tbody></tbody>`;
  const tbody = table.querySelector("tbody");
  
  itensDoDia.forEach((item) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${item.patrimonio || "-"}</td><td>${item.setor}</td><td>${item.ambiente}</td><td>${item.equipeResponsavel}</td>`;
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
        await updateDoc(doc(db, "equipamentos", item.id), { statusPreventiva: statusNovo });
        const promessasLogs = [registrarHistorico(item, statusAnterior, statusNovo)];
        if (statusNovo === "Concluída") {
          promessasLogs.push(registrarOrdemServico(item));
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
  const itens = ESTADO.equipamentos;
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
}

// ---------------------------------------------------------------------------
// Ordens de serviço
// ---------------------------------------------------------------------------
async function registrarHistorico(item, statusAnterior, statusNovo) {
  const agora = new Date();
  await addDoc(collection(db, "historico"), {
    equipamentoId: item.id,
    patrimonio: item.patrimonio || "",
    setor: item.setor || "",
    ambiente: item.ambiente || "",
    equipe: item.equipeResponsavel || "",
    tipo: "Preventiva",
    statusAnterior: statusAnterior || "Pendente",
    statusNovo: statusNovo,
    registradoEm: agora.toISOString()
  });
}

async function registrarOrdemServico(item) {
  const agora = new Date();
  await addDoc(collection(db, "ordens"), {
    equipamentoId: item.id,
    patrimonio: item.patrimonio || "",
    setor: item.setor || "",
    ambiente: item.ambiente || "",
    equipe: item.equipeResponsavel || "",
    dataAgendada: item.dataAgendada || "",
    status: "Concluída", 
    registradoEm: agora.toISOString(),
  });
}

function iniciarSincronizacaoOrdens() {
  if (ESTADO.unsubscribeOrdens) ESTADO.unsubscribeOrdens();
  const q = query(collection(db, "ordens"), orderBy("registradoEm", "desc"), limit(300));
  ESTADO.unsubscribeOrdens = onSnapshot(q, (snap) => {
    ESTADO.ordens = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderOrdens();
  }, (err) => {
    console.error(err);
    toast("Erro ao ler ordens de serviço: " + err.message);
  });
}
iniciarSincronizacaoOrdens();

function iniciarSincronizacaoHistorico(){
  if(ESTADO.unsubscribeHistorico) ESTADO.unsubscribeHistorico();
  const q = query(collection(db,"historico"), orderBy("registradoEm","desc"));

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

// ---------------------------------------------------------------------------
// Renderizadores de tabelas de log
// ---------------------------------------------------------------------------
function renderHistorico(){
  const table = $("#historicoTable");
  if(!table) return;

  $("#historicoCount").textContent = `${ESTADO.historico.length} movimentações`;
  table.innerHTML = `
      <thead>
          <tr>
              <th>Data/Hora</th><th>Patrimônio</th><th>Setor</th>
              <th>Equipe</th><th>De</th><th>Para</th>
          </tr>
      </thead>
      <tbody>
      ${ESTADO.historico.map(h => `
          <tr>
              <td>${new Date(h.registradoEm).toLocaleString("pt-BR")}</td>
              <td>${h.patrimonio || "-"}</td>
              <td>${h.setor}</td>
              <td>${h.equipe}</td>
              <td><span class="status-select ${classeStatus(h.statusAnterior)}" style="cursor:default">${h.statusAnterior || "-"}</span></td>
              <td><span class="status-select ${classeStatus(h.statusNovo)}" style="cursor:default">${h.statusNovo}</span></td>
          </tr>
      `).join("")}
      </tbody>
  `;
}

function renderOrdens() {
  const table = $("#ordensTable");
  if (!table) return;
  $("#ordensCount").textContent = `${ESTADO.ordens.length} OS Emitidas`;
  
  table.innerHTML = `<thead><tr>
      <th>Data de Conclusão</th><th>Patrimônio</th><th>Setor</th><th>Ambiente</th>
      <th>Equipe</th><th>Ações</th>
    </tr></thead><tbody></tbody>`;
    
  const tbody = table.querySelector("tbody");
  
  ESTADO.ordens.forEach((o) => {
    const dt = new Date(o.registradoEm);
    const dataFmt = dt.toLocaleString("pt-BR");
    const tr = document.createElement("tr");
    
    tr.innerHTML = `
      <td>${dataFmt}</td><td>${o.patrimonio || "-"}</td><td>${o.setor || ""}</td>
      <td>${o.ambiente || ""}</td><td>${o.equipe || ""}</td>
    `;
    
    // Botão de imprimir a OS
    const tdBtn = document.createElement("td");
    const btnPrint = document.createElement("button");
    btnPrint.className = "btn ghost";
    btnPrint.textContent = "🖨️ PMOC";
    btnPrint.style.color = "var(--azul)"; 
    btnPrint.addEventListener("click", () => gerarPDFPMOC(o));
    
    tdBtn.appendChild(btnPrint);
    tr.appendChild(tdBtn);
    tbody.appendChild(tr);
  });
}
// ---------------------------------------------------------------------------
// Cadastro e Edição de equipamentos (CRUD unificado)
// ---------------------------------------------------------------------------
const btnAdicionarEquipamento = $("#btnAdicionarEquipamento");
if (btnAdicionarEquipamento) {
  btnAdicionarEquipamento.addEventListener("click", adicionarEquipamentoManual);
}

function prepararEdicao(item) {
  idEquipamentoEmEdicao = item.id;
  $("#eqPatrimonio").value = item.patrimonio || "";
  $("#eqSetor").value = item.setor || "";
  $("#eqAmbiente").value = item.ambiente || "";
  
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
    // CORREÇÃO: MODO EDIÇÃO - Salva dados mantendo o agendamento inalterado
    try {
      await updateDoc(doc(db, "equipamentos", idEquipamentoEmEdicao), {
        patrimonio, setor, ambiente, setorPCM, prioridadeSetor, pisoPCM
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
    // CORREÇÃO: MODO CADASTRO NOVO - Encaixa perfeitamente no fim da fila existente
    const id = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    
    let agendamento = {
      ordemExecucao: 999999,
      dataAgendada: "",
      diaPlanejado: "",
      semanaPlanejada: "",
      equipeResponsavel: ""
    };

    const filtrados = ESTADO.equipamentos.filter(e => e.dataAgendada).sort((a, b) => a.ordemExecucao - b.ordemExecucao);
    
    if (filtrados.length > 0) {
      const nEquipes = Math.max(1, parseInt($("#nEquipes")?.value, 10) || 1);
      const aparelhosDia = Math.max(1, parseInt($("#aparelhosDia")?.value, 10) || 1);
      const diasSemana = Math.min(7, Math.max(1, parseInt($("#diasSemana")?.value, 10) || 5));
      const DIAS_UTEIS = NOMES_DIAS.slice(0, diasSemana);
      const capacidadeDia = nEquipes * aparelhosDia;

      function ehDiaUtilLocal(data) {
        return DIAS_UTEIS.includes(NOMES_DIAS[(data.getDay() + 6) % 7]) && !estaEmFeriado(data);
      }

      const ultimo = filtrados[filtrados.length - 1];
      const [uAno, uMes, uDia] = ultimo.dataAgendada.split("-");
      let dataCursor = new Date(uAno, parseInt(uMes, 10) - 1, uDia, 12, 0, 0);

      const itensNoMesmoDia = filtrados.filter(e => e.dataAgendada === ultimo.dataAgendada).length;

      if (itensNoMesmoDia >= capacidadeDia) {
        do {
          dataCursor.setDate(dataCursor.getDate() + 1);
        } while (!ehDiaUtilLocal(dataCursor));
      }

      agendamento.dataAgendada = formatISO(dataCursor);
      agendamento.diaPlanejado = NOMES_DIAS[(dataCursor.getDay() + 6) % 7];
      agendamento.ordemExecucao = ultimo.ordemExecucao + 1;

      const primeiro = filtrados[0];
      const [pAno, pMes, pDia] = primeiro.dataAgendada.split("-");
      const primeiraDataUtil = new Date(pAno, pMes - 1, pDia, 12, 0, 0);
      const diffDias = Math.floor((dataCursor - primeiraDataUtil) / 86400000);
      agendamento.semanaPlanejada = `Semana ${Math.floor(diffDias / 7) + 1}`;

      const contagemEquipesDia = filtrados.filter(e => e.dataAgendada === agendamento.dataAgendada).length;
      agendamento.equipeResponsavel = `Equipe ${(contagemEquipesDia % nEquipes) + 1}`;
    }

    const item = {
      id, patrimonio, setor, ambiente,
      statusCondicao: "",
      setorPCM,
      prioridadeSetor,
      pisoPCM,
      statusPreventiva: "Pendente",
      observacao: "",
      origem: "manual",
      ...agendamento
    };

    try {
      await setDoc(doc(db, "equipamentos", id), item);
      toast(agendamento.dataAgendada ? `Encaixado na agenda para ${agendamento.dataAgendada}!` : "Equipamento adicionado.");
    } catch (err) {
      console.error(err);
      toast("Erro ao adicionar: " + err.message);
      return;
    }
  }

  // Limpa campos após salvar ou atualizar
  $("#eqPatrimonio").value = "";
  $("#eqSetor").value = "";
  $("#eqAmbiente").value = "";
}

async function removerEquipamento(id, descricao) {
  const ok = window.confirm(`Remover "${descricao}"? Essa ação não pode ser desfeita.`);
  if (!ok) return;
  try {
    await deleteDoc(doc(db, "equipamentos", id));
    toast("Equipamento removido.");
  } catch (err) {
    console.error(err);
    toast("Erro ao remover: " + err.message);
  }
}

function renderEquipamentosCadastro() {
  const table = $("#equipamentosTable");
  if (!table) return;
  const itens = ESTADO.equipamentos;
  $("#equipamentosCount").textContent = `${itens.length} itens`;
  table.innerHTML = `<thead><tr>
      <th>Patrimônio</th><th>Setor</th><th>Ambiente</th><th>Setor PCM</th>
      <th>Status</th><th>Origem</th><th>Ações</th>
    </tr></thead><tbody></tbody>`;
  const tbody = table.querySelector("tbody");
  
  itens.forEach((item) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${item.patrimonio || "-"}</td><td>${item.setor}</td><td>${item.ambiente}</td>
      <td>${item.setorPCM}</td>
      <td><span class="status-select ${classeStatus(item.statusPreventiva)}" style="cursor:default">${item.statusPreventiva}</span></td>
      <td>${item.origem === "manual" ? "Manual" : "Planilha"}</td>`;
    
    const tdBtn = document.createElement("td");
    
    // CORREÇÃO: Adicionado botão Editar ao painel de listagem
    const btnEdit = document.createElement("button");
    btnEdit.className = "btn ghost";
    btnEdit.textContent = "Editar";
    btnEdit.style.marginRight = "6px";
    btnEdit.addEventListener("click", () => prepararEdicao(item));
    
    const btnDel = document.createElement("button");
    btnDel.className = "btn ghost";
    btnDel.textContent = "Remover";
    btnDel.addEventListener("click", () => removerEquipamento(item.id, item.patrimonio || item.ambiente));
    
    tdBtn.appendChild(btnEdit);
    tdBtn.appendChild(btnDel);
    tr.appendChild(tdBtn);
    tbody.appendChild(tr);
  });
}

// ---------------------------------------------------------------------------
// Feriados e férias
// ---------------------------------------------------------------------------
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
    await addDoc(collection(db, "feriados"), {
      tipo, label: label || (tipo === "feriado" ? "Feriado" : "Férias"),
      dataInicio, dataFim,
    });
    $("#feriadoLabel").value = "";
    $("#feriadoInicio").value = "";
    $("#feriadoFim").value = "";
    toast("Data cadastrada.");
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
    toast("Removido.");
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
  $("#feriadosCount").textContent = `${ESTADO.feriados.length} datas`;
  table.innerHTML = `<thead><tr><th>Tipo</th><th>Descrição</th><th>Início</th><th>Fim</th><th></th></tr></thead><tbody></tbody>`;
  const tbody = table.querySelector("tbody");
  ESTADO.feriados.forEach((f) => {
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

// ---------------------------------------------------------------------------
// Exportação para Excel
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Apagar cronograma
// ---------------------------------------------------------------------------
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
      pedaco.forEach((id) => batch.delete(doc(db, "equipamentos", id)));
      await batch.commit();
    }

    ESTADO.equipamentos = [];
    ESTADO.itensCarregados = [];
    ESTADO.diaSelecionado = null;

    $("#previewCard").hidden = true;
    $("#resumoCapacidade").textContent = "";
    $("#dayDetailCard").hidden = true;

    renderCalendar();
    renderDashboard();

    toast(`Cronograma apagado (${ids.length} itens removidos).`);
  } catch (err) {
    console.error(err);
    toast("Erro ao apagar cronograma: " + err.message);
  } finally {
    btnApagarCronograma.disabled = false;
  }
}
// ---------------------------------------------------------------------------
// Geração de PDF (PMOC)
// ---------------------------------------------------------------------------
function gerarPDFPMOC(ordem) {
  // Busca os dados extras do equipamento usando o ID guardado na ordem
  const eqFull = ESTADO.equipamentos.find(e => e.id === ordem.equipamentoId) || {};
  
  const idEquip = eqFull.patrimonio || ordem.patrimonio || "Sem Patrimônio";
  const setor = eqFull.setorPCM || ordem.setor || "Não informado";
  const ambiente = eqFull.ambiente || ordem.ambiente || "-";
  const prioridade = eqFull.prioridadeSetor || "-";
  const equipe = ordem.equipe || eqFull.equipeResponsavel || "-";
  
  // Pega a data de agendamento ou a data do registro da ordem
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
