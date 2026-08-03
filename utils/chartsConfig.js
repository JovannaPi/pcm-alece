function renderGraficoTendencia(equipamentos) {
  const ctx = document.getElementById('graficoTendencia').getContext('2d');

  const ultimosMeses = [];
  for (let i = 6; i >= 0; i--) {
    const data = new Date();
    data.setMonth(data.getMonth() - i);
    ultimosMeses.push(data.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }));
  }

  const concluidas = [12, 15, 18, 22, 25, 28, 32];
  const emAndamento = [8, 10, 12, 14, 16, 18, 20];
  const pendentes = [20, 18, 15, 12, 10, 8, 5];

  new Chart(ctx, {
    type: 'line',
    data: {
      labels: ultimosMeses,
      datasets: [
        {
          label: 'Concluídas',
          data: concluidas,
          borderColor: '#28A745',
          backgroundColor: 'rgba(40, 167, 69, 0.1)',
          borderWidth: 2,
          tension: 0.4,
          fill: true
        },
        {
          label: 'Em Andamento',
          data: emAndamento,
          borderColor: '#FFC107',
          backgroundColor: 'rgba(255, 193, 7, 0.1)',
          borderWidth: 2,
          tension: 0.4,
          fill: true
        },
        {
          label: 'Pendentes',
          data: pendentes,
          borderColor: '#DC3545',
          backgroundColor: 'rgba(220, 53, 69, 0.1)',
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
          text: 'Tendência de Execução (Últimos 7 Meses)',
          font: { size: 14, weight: 'bold' }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { font: { size: 12 } }
        },
        x: {
          ticks: { font: { size: 12 } }
        }
      }
    }
  });
}

function renderGraficoDistribuicao(equipamentos) {
  const ctx = document.getElementById('graficoDistribuicao').getContext('2d');

  const concluidas = equipamentos.filter(e => e.statusPreventiva === 'Concluída').length;
  const emAndamento = equipamentos.filter(e => e.statusPreventiva === 'Em andamento').length;
  const pendentes = equipamentos.filter(e => e.statusPreventiva === 'Pendente').length;

  new Chart(ctx, {
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
  const ctx = document.getElementById('graficoPorSetor').getContext('2d');

  const porSetor = {};
  equipamentos.forEach(e => {
    const setor = e.setorPCM || 'Não classificado';
    if (!porSetor[setor]) porSetor[setor] = 0;
    porSetor[setor]++;
  });

  new Chart(ctx, {
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
          ticks: { font: { size: 12 } }
        },
        y: {
          ticks: { font: { size: 12 } }
        }
      }
    }
  });
}

function renderGraficoProgresso(equipamentos) {
  const ctx = document.getElementById('graficoProgresso').getContext('2d');

  const concluidas = equipamentos.filter(e => e.statusPreventiva === 'Concluída').length;
  const total = equipamentos.length;
  const percentual = (concluidas / total * 100).toFixed(1);

  const dadosProgresso = [percentual, 100 - percentual];

  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['Completado', 'Restante'],
      datasets: [{
        label: 'Taxa de Execução (%)',
        data: dadosProgresso,
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
