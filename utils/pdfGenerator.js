function gerarRelatorioPDF(equipamentos, cicloInfo) {
  const hoje = new Date();
  const dataFormatada = hoje.toLocaleDateString('pt-BR');

  const concluidas = equipamentos.filter(e => e.statusPreventiva === 'Concluída').length;
  const andamento = equipamentos.filter(e => e.statusPreventiva === 'Em andamento').length;
  const pendentes = equipamentos.filter(e => e.statusPreventiva === 'Pendente').length;
  const execucao = ((concluidas + andamento) / equipamentos.length * 100).toFixed(1);

  const porSetor = {};
  equipamentos.forEach(e => {
    const setor = e.setorPCM || 'Não classificado';
    if (!porSetor[setor]) porSetor[setor] = [];
    porSetor[setor].push(e);
  });

  let conteudoHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body {
          font-family: Arial, sans-serif;
          margin: 40px;
          color: #333;
        }
        .cabecalho {
          border-bottom: 3px solid #1F4E78;
          padding-bottom: 20px;
          margin-bottom: 30px;
        }
        .titulo {
          color: #1F4E78;
          font-size: 24px;
          font-weight: bold;
          margin: 0;
        }
        .data {
          color: #666;
          font-size: 12px;
          margin-top: 5px;
        }
        .kpi-container {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 15px;
          margin: 30px 0;
        }
        .kpi {
          background: #f9f9f9;
          border-left: 4px solid #1F4E78;
          padding: 15px;
          border-radius: 4px;
        }
        .kpi-label {
          font-size: 12px;
          color: #666;
          text-transform: uppercase;
        }
        .kpi-valor {
          font-size: 28px;
          font-weight: bold;
          color: #1F4E78;
          margin-top: 10px;
        }
        .secao {
          margin-top: 40px;
          page-break-inside: avoid;
        }
        .secao-titulo {
          color: #1F4E78;
          font-size: 16px;
          font-weight: bold;
          border-bottom: 2px solid #1F4E78;
          padding-bottom: 10px;
          margin-bottom: 15px;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 20px;
        }
        th {
          background: #1F4E78;
          color: white;
          padding: 12px;
          text-align: left;
          font-size: 12px;
        }
        td {
          padding: 10px 12px;
          border-bottom: 1px solid #ddd;
          font-size: 12px;
        }
        tr:nth-child(even) {
          background: #f9f9f9;
        }
        .status-concluida {
          color: #28A745;
          font-weight: bold;
        }
        .status-andamento {
          color: #FFC107;
          font-weight: bold;
        }
        .status-pendente {
          color: #DC3545;
          font-weight: bold;
        }
        .rodape {
          margin-top: 40px;
          padding-top: 20px;
          border-top: 1px solid #ddd;
          font-size: 11px;
          color: #666;
          text-align: center;
        }
      </style>
    </head>
    <body>
      <div class="cabecalho">
        <h1 class="titulo">PMOK ALECE - Relatório de Manutenção Preventiva</h1>
        <div class="data">Gerado em ${dataFormatada}</div>
      </div>

      <div class="kpi-container">
        <div class="kpi">
          <div class="kpi-label">Total de Equipamentos</div>
          <div class="kpi-valor">${equipamentos.length}</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">Concluídas</div>
          <div class="kpi-valor">${concluidas}</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">Em Andamento</div>
          <div class="kpi-valor">${andamento}</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">Taxa de Execução</div>
          <div class="kpi-valor">${execucao}%</div>
        </div>
      </div>

      <div class="secao">
        <div class="secao-titulo">Resumo por Setor</div>
        <table>
          <thead>
            <tr>
              <th>Setor</th>
              <th>Total</th>
              <th>Concluídas</th>
              <th>Em Andamento</th>
              <th>Pendentes</th>
              <th>Progresso</th>
            </tr>
          </thead>
          <tbody>
  `;

  Object.entries(porSetor).forEach(([setor, itens]) => {
    const setorConcluidas = itens.filter(e => e.statusPreventiva === 'Concluída').length;
    const setorAndamento = itens.filter(e => e.statusPreventiva === 'Em andamento').length;
    const setorPendentes = itens.filter(e => e.statusPreventiva === 'Pendente').length;
    const setorProgresso = ((setorConcluidas + setorAndamento) / itens.length * 100).toFixed(0);

    conteudoHTML += `
      <tr>
        <td>${setor}</td>
        <td>${itens.length}</td>
        <td>${setorConcluidas}</td>
        <td>${setorAndamento}</td>
        <td>${setorPendentes}</td>
        <td>${setorProgresso}%</td>
      </tr>
    `;
  });

  conteudoHTML += `
          </tbody>
        </table>
      </div>

      <div class="secao">
        <div class="secao-titulo">Equipamentos em Atraso</div>
  `;

  const hojeISO = new Date().toISOString().split('T')[0];
  const atrasados = equipamentos.filter(e =>
    e.dataAgendada < hojeISO && e.statusPreventiva !== 'Concluída'
  );

  if (atrasados.length > 0) {
    conteudoHTML += `
      <table>
        <thead>
          <tr>
            <th>Patrimônio</th>
            <th>Setor</th>
            <th>Ambiente</th>
            <th>Data Agendada</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
    `;

    atrasados.forEach(eq => {
      const classeStatus = eq.statusPreventiva === 'Concluída' ? 'status-concluida'
        : eq.statusPreventiva === 'Em andamento' ? 'status-andamento'
        : 'status-pendente';

      conteudoHTML += `
        <tr>
          <td>${eq.patrimonio || '-'}</td>
          <td>${eq.setor}</td>
          <td>${eq.ambiente}</td>
          <td>${eq.dataAgendada}</td>
          <td><span class="${classeStatus}">${eq.statusPreventiva}</span></td>
        </tr>
      `;
    });

    conteudoHTML += `
        </tbody>
      </table>
    `;
  } else {
    conteudoHTML += '<p>Nenhum equipamento atrasado no momento.</p>';
  }

  conteudoHTML += `
      </div>

      <div class="rodape">
        <p>PMOK ALECE - Sistema de Manutenção Preventiva</p>
        <p>Assembleia Legislativa do Estado do Ceará</p>
      </div>
    </body>
    </html>
  `;

  return conteudoHTML;
}

function baixarRelatorioPDF(equipamentos, cicloInfo) {
  const html = gerarRelatorioPDF(equipamentos, cicloInfo);

  const opt = {
    margin: 10,
    filename: `relatorio-pmok-${new Date().toISOString().split('T')[0]}.pdf`,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2 },
    jsPDF: { orientation: 'portrait', unit: 'mm', format: 'a4' }
  };

  html2pdf().set(opt).from(html).save();
}
