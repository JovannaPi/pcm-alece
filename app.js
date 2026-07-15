import { db } from "./firebase-config.js";
import {
  collection, doc, setDoc, getDocs, onSnapshot, updateDoc, query, orderBy, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---------------------------------------------------------------------------
// Constantes / regras de classificação (mesma lógica do script Python original)
// ---------------------------------------------------------------------------
const PRIORIDADE = {
  "1 - Presidência": 1, "2 - Primeiro Secretário": 2, "3 - Gabinetes": 3,
  "4 - TI/Racks": 4, "5 - Plenário": 5, "6 - Administração": 6, "7 - Todo o resto": 7,
};
const NOMES_DIAS = ["Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo"];
const OFFSET_DIA = { Segunda: 0, Terça: 1, Quarta: 2, Quinta: 3, Sexta: 4, Sábado: 5, Domingo: 6 };
const STATUS_VALIDOS = ["Pendente", "Em andamento", "Concluída"];

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

function mondaySameWeek(dateInput) {
  const d = new Date(dateInput + "T00:00:00");
  const day = d.getDay(); // 0=domingo .. 6=sábado
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function formatISO(date) {
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Estado da aplicação
// ---------------------------------------------------------------------------
const ESTADO = {
  meta: null,               // { colSetor, colAmbiente, colStatus, colPatrimonio }
  itensCarregados: [],      // itens recém-lidos do arquivo (antes de gerar cronograma)
  equipamentos: [],         // itens já com cronograma, sincronizados com o Firestore
  unsubscribe: null,
  calYear: null,
  calMonth: null,           // 0-indexado
  diaSelecionado: null,     // "YYYY-MM-DD"
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

// ---------------------------------------------------------------------------
// Navegação por abas
// ---------------------------------------------------------------------------
$all(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    $all(".tab").forEach((b) => b.classList.remove("active"));
    $all(".view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    $(`#view-${btn.dataset.view}`).classList.add("active");
    if (btn.dataset.view === "calendar") renderCalendar();
    if (btn.dataset.view === "dashboard") renderDashboard();
  });
});

function irParaAba(nome) {
  $(`.tab[data-view="${nome}"]`)?.click();
}

// ---------------------------------------------------------------------------
// Upload + classificação
// ---------------------------------------------------------------------------
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
    // ... resto continua igual
    const setorPCM = identificarSetor(setor, ambiente);
    const patrimonio = colPatrimonio ? String(row[colPatrimonio]) : "";
    return {
      id: patrimonio ? `${patrimonio.replace(/[\s/\\"']/g, "_")}_${idx}` : `item_${idx}`,
      patrimonio,
      setor, ambiente,
      statusCondicao: colStatus ? row[colStatus] : "",
      setorPCM,
      prioridadeSetor: PRIORIDADE[setorPCM],
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

// ---------------------------------------------------------------------------
// Geração do cronograma + gravação no Firestore
// ---------------------------------------------------------------------------
$("#btnGerar").addEventListener("click", gerarCronograma);

async function gerarCronograma() {
  if (!ESTADO.itensCarregados.length) {
    toast("Envie e classifique um levantamento primeiro.");
    irParaAba("upload");
    return;
  }
  const nEquipes = Math.max(1, parseInt($("#nEquipes").value, 10) || 1);
  const aparelhosDia = Math.max(1, parseInt($("#aparelhosDia").value, 10) || 1);
  const diasSemana = Math.min(7, Math.max(1, parseInt($("#diasSemana").value, 10) || 5));
  const dataInicioStr = $("#dataInicio").value;
  if (!dataInicioStr) {
    toast("Escolha a data de início do cronograma.");
    return;
  }
  const segundaBase = mondaySameWeek(dataInicioStr);
  const capacidadeDia = nEquipes * aparelhosDia;

  const itens = ESTADO.itensCarregados.map((i) => ({ ...i }));
  let semana = 1, dia = 0, contador = 0;
  itens.forEach((item, idx) => {
    item.semanaPlanejada = `Semana ${semana}`;
    item.diaPlanejado = NOMES_DIAS[dia];
    item.ordemExecucao = idx + 1;
    item.equipeResponsavel = `Equipe ${(contador % nEquipes) + 1}`;

    const dataReal = new Date(segundaBase);
    dataReal.setDate(dataReal.getDate() + (semana - 1) * 7 + OFFSET_DIA[NOMES_DIAS[dia]]);
    item.dataAgendada = formatISO(dataReal);

    contador++;
    if (contador >= capacidadeDia) {
      contador = 0; dia++;
      if (dia >= diasSemana) { dia = 0; semana++; }
    }
  });

  const diasNecessarios = Math.ceil(itens.length / capacidadeDia);
  const semanasNecessarias = Math.ceil(diasNecessarios / diasSemana);
  $("#resumoCapacidade").textContent =
    `Capacidade diária: ${capacidadeDia} aparelhos · Dias necessários: ${diasNecessarios} · Semanas necessárias: ${semanasNecessarias}`;

  toast("Lendo dados anteriores...");
  $("#btnGerar").disabled = true;
  try {
    const existentesSnap = await getDocs(collection(db, "equipamentos"));
    const existentes = {};
    const idsAntigos = [];
    existentesSnap.forEach((d) => {
      existentes[d.id] = d.data();
      idsAntigos.push(d.id);
    });

    // Preserva status/observação dos itens que continuam existindo no novo arquivo
    itens.forEach((item) => {
      const anterior = existentes[item.id];
      if (anterior) {
        item.statusPreventiva = anterior.statusPreventiva || "Pendente";
        item.observacao = anterior.observacao || "";
      }
    });

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
      const primeira = new Date(ESTADO.equipamentos[0].dataAgendada + "T00:00:00");
      ESTADO.calYear = primeira.getFullYear();
      ESTADO.calMonth = primeira.getMonth();
    }
    renderCalendar();
    renderDashboard();
  }, (err) => {
    console.error(err);
    toast("Erro ao ler dados do Firebase: " + err.message);
  });
}

// Também escuta o Firestore desde o início (caso já existam dados de uma sessão anterior)
iniciarSincronizacao();

// ---------------------------------------------------------------------------
// Calendário
// ---------------------------------------------------------------------------
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

  // agrupa equipamentos por data
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
  const offsetInicial = (primeiroDia.getDay() + 6) % 7; // segunda = 0
  const diasNoMes = new Date(ESTADO.calYear, ESTADO.calMonth + 1, 0).getDate();

  for (let i = 0; i < offsetInicial; i++) {
    const el = document.createElement("div");
    el.className = "cal-day empty";
    grid.appendChild(el);
  }

  for (let dia = 1; dia <= diasNoMes; dia++) {
    const iso = `${ESTADO.calYear}-${String(ESTADO.calMonth + 1).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
    const itensDoDia = porData[iso] || [];
    const el = document.createElement("div");
    el.className = "cal-day" + (itensDoDia.length ? " has-tasks" : "") + (ESTADO.diaSelecionado === iso ? " selected" : "");

    const num = document.createElement("div");
    num.className = "cal-day-num";
    num.textContent = dia;
    el.appendChild(num);

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
      select.className = "status-select " + classeStatus(select.value);
      await updateDoc(doc(db, "equipamentos", item.id), { statusPreventiva: select.value });
      toast(`Status de ${item.patrimonio || item.ambiente} atualizado.`);
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

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
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


// Exportação para Excel
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
  return 5; // linha 4 fica livre como respiro
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

  // --- Aba Resumo ---
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

  // --- Aba Cronograma ---
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

  const statusCondIdx = colunas.findIndex(([k]) => k === "statusCondicao") + 1;

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
    if (statusCondIdx) {
      const statusVal = String(item.statusCondicao || "").trim().toUpperCase();
      const corFundo = STATUS_COND_COLORS[statusVal];
      if (corFundo) {
        ws2.getCell(rIdx, statusCondIdx).fill = { type: "pattern", pattern: "solid", fgColor: { argb: corFundo } };
      }
    }
  });

  const larguras = { 1: 14, 2: 24, 3: 30, 4: 14, 5: 22, 6: 8, 7: 14, 8: 12, 9: 14, 10: 10, 11: 12, 12: 14, 13: 24 };
  Object.entries(larguras).forEach(([i, w]) => {
    if (Number(i) <= colunas.length) ws2.getColumn(Number(i)).width = w;
  });

  const ultimaColunaLetra = colLetra(colunas.length);
  ws2.autoFilter = `A${linhaCabecalhoTabela}:${ultimaColunaLetra}${ultimaLinha}`;

  if (statusPrevIdx) {
    const colLetraStatus = colLetra(statusPrevIdx);
    const faixaStatus = `${colLetraStatus}${primeiraLinhaDados}:${colLetraStatus}${ultimaLinha}`;
    const celulaAncora = `${colLetraStatus}${primeiraLinhaDados}`;
    const regras = [
      ["Pendente", STATUS_PREV_COLORS.Pendente],
      ["Em andamento", STATUS_PREV_COLORS["Em andamento"]],
      ["Concluída", STATUS_PREV_COLORS["Concluída"]],
    ];
    regras.forEach(([texto, cores], i) => {
      ws2.addConditionalFormatting({
        ref: faixaStatus,
        rules: [
          {
            type: "expression",
            formulae: [`EXACT(${celulaAncora},"${texto}")`],
            style: {
              fill: { type: "pattern", pattern: "solid", fgColor: { argb: cores.fill } },
              font: { bold: true, color: { argb: cores.font } },
            },
            priority: i + 1,
            stopIfTrue: true,
          },
        ],
      });
    });
  }

  // --- Aba Dashboard (sem gráficos - só KPIs e tabelas) ---
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
  proxima = uPiso + 3;

  const equipesValidas = itens.filter((i) => i.equipeResponsavel);
  if (equipesValidas.length) {
    const contagemEquipe = [...contarPor(equipesValidas, "equipeResponsavel").entries()]
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const [, uEquipe] = escreverTabelaContagem(ws3, 1, proxima, "Equipamentos por equipe", contagemEquipe);
    proxima = uEquipe + 3;
  }

  const semanasValidas = itens.filter((i) => i.semanaPlanejada);
  if (semanasValidas.length) {
    const contagemSemana = [...contarPor(semanasValidas, "semanaPlanejada").entries()]
      .sort((a, b) => parseInt(a[0].match(/\d+/)[0], 10) - parseInt(b[0].match(/\d+/)[0], 10));
    escreverTabelaContagem(ws3, 1, proxima, "Equipamentos por semana", contagemSemana);
  }

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
    const workbook = await montarPlanilhaDetalhada(ESTADO.equipamentos);
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
