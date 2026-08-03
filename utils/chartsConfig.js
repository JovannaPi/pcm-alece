const graficosAtivos = {};

function destruirGrafico(chave) {
  if (graficosAtivos[chave]) {
    graficosAtivos[chave].destroy();
    graficosAtivos[chave] = null;
  }
}

function renderGraficoTendencia(equipamentos, historico) {
  const canvas = document.getElementById('graficoTendencia');
  if (!canvas) return;
  destruirGrafico('tendencia');

  const meses = [];
  for (let i = 6; i >= 0; i--) {
    const data = new Date();
    data.setDate(1);
    data.setMonth(data.getMonth() - i);
    meses.push({
      chave: `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, '0')}`,
      label: data.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' })
    });
  }

  const concluidasPorMes = {};
  (historico || []).forEach(h => {
    if (h.statusNovo !== 'Concluída' || !h.registradoEm) return;
    const chave = h.registradoEm.slice(0, 7);
    concluidasPorMes[chave] = (concluidasPorMes[chave] || 0) + 1;
  });

  graficosAtivos.tendencia = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: meses.map(m => m.label),
      datasets: [
        {
          label: 'Concluídas',
          data: meses.map(m => concluidasPorMes[m.chave] || 0),
          borderColor: '#28A745',
          backgroundColor: 'rgba(40, 167, 69, 0.1)',
          borderWidth: 2,
          tension: 0.4,
          fill: true
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          position: 'top',
          labels: { font: { size: 13 }, padding: 15 }
        },
        title: {
          display: true,
          text: 'Manutenções Concluídas (Últimos 7 Meses)',
          font: { size: 14, weight: 'bold' }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { precision: 0, font: { size: 12 } }
        },
        x: {
          ticks: { font: { size: 12 } }
        }
      }
    }
  });
}

function renderGraficoDistribuicao(equipamentos) {
  const canvas = document.getElementById('graficoDistribuicao');
  if (!canvas) return;
  destruirGrafico('distribuicao');

  const concluidas = equipamentos.filter(e => e.statusPreventiva === 'Concluída').length;
  const emAndamento = equipamentos.filter(e => e.statusPreventiva === 'Em andamento').length;
  const pendentes = equipamentos.length - concluidas - emAndamento;

  graficosAtivos.distribuicao = new Chart(canvas.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: ['Concluídas', 'Em Andamento', 'Pendentes'],
      datasets: [{
        data: [concluidas, emAndamento, pendentes],
        backgroundColor: ['#28A745', '#FFC107', '#DC3545'],
        borderColor: ['#fff', '#fff', '#fff'],
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          position: 'right',
          labels: { font: { size: 13 }, padding: 15 }
        },
        title: {
          display: true,
          text: 'Distribuição de Status',
          font: { size: 14, weight: 'bold' }
        }
      }
    }
  });
}

function renderGraficoPorSetor(equipamentos) {
  const canvas = document.getElementById('graficoPorSetor');
  if (!canvas) return;
  destruirGrafico('porSetor');

  const porSetor = {};
  equipamentos.forEach(e => {
    const setor = e.setorPCM || 'Não classificado';
    if (!porSetor[setor]) porSetor[setor] = 0;
    porSetor[setor]++;
  });

  graficosAtivos.porSetor = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: Object.keys(porSetor),
      datasets: [{
        label: 'Equipamentos por Setor',
        data: Object.values(porSetor),
        backgroundColor: '#1F4E78',
        borderColor: '#0a1f2e',
        borderWidth: 1
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          display: false
        },
        title: {
          display: true,
          text: 'Equipamentos por Setor',
          font: { size: 14, weight: 'bold' }
        }
      },
      scales: {
        x: {
          beginAtZero: true,
          ticks: { precision: 0, font: { size: 12 } }
        },
        y: {
          ticks: { font: { size: 12 } }
        }
      }
    }
  });
}

function renderGraficoProgresso(equipamentos) {
  const canvas = document.getElementById('graficoProgresso');
  if (!canvas) return;
  destruirGrafico('progresso');

  const concluidas = equipamentos.filter(e => e.statusPreventiva === 'Concluída').length;
  const total = equipamentos.length;
  const percentual = total ? Number((concluidas / total * 100).toFixed(1)) : 0;

  graficosAtivos.progresso = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: ['Completado', 'Restante'],
      datasets: [{
        label: 'Taxa de Execução (%)',
        data: [percentual, 100 - percentual],
        backgroundColor: ['#28A745', '#e9ecef'],
        borderColor: ['#1e7e34', '#dee2e6'],
        borderWidth: 1
      }]
    },
    options: {
      indexAxis: 'x',
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: `Taxa de Execução: ${percentual}%`,
          font: { size: 14, weight: 'bold' }
        }
      },
      scales: {
        x: { max: 100 },
        y: { display: false }
      }
    }
  });
}
