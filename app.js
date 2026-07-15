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

// ---------------------------------------------------------------------------
// Exportação para Excel
// ---------------------------------------------------------------------------
$("#btnExport").addEventListener("click", () => {
  if (!ESTADO.equipamentos.length) {
    toast("Gere o cronograma primeiro.");
    return;
  }
  const linhas = ESTADO.equipamentos.map((i) => ({
    "Patrimônio": i.patrimonio, "Setor": i.setor, "Ambiente": i.ambiente,
    "Status Condição": i.statusCondicao, "Setor PCM": i.setorPCM,
    "Piso": i.pisoPCM === 99 ? "" : i.pisoPCM,
    "Data Agendada": i.dataAgendada, "Equipe": i.equipeResponsavel,
    "Status Preventiva": i.statusPreventiva, "Observação": i.observacao,
  }));
  const ws = XLSX.utils.json_to_sheet(linhas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Cronograma");
  const agora = new Date();
  const nome = `PCM_ALCE_${agora.getFullYear()}_${String(agora.getMonth() + 1).padStart(2, "0")}.xlsx`;
  XLSX.writeFile(wb, nome);
});
