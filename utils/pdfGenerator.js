function gerarRelatorioPDF(equipamentos, cicloInfo, historico) {
  const hoje = new Date();
  const dataFormatada = hoje.toLocaleDateString('pt-BR');
  const hojeISO = hoje.toISOString().split('T')[0];

  const seteDiasAtras = new Date(hoje);
  seteDiasAtras.setDate(seteDiasAtras.getDate() - 7);
  const seteDiasAtrasISO = seteDiasAtras.toISOString();
  const seteDiasAtrasData = seteDiasAtras.toISOString().split('T')[0];

  const catorzeDiasAtras = new Date(hoje);
  catorzeDiasAtras.setDate(catorzeDiasAtras.getDate() - 14);
  const catorzeDiasAtrasISO = catorzeDiasAtras.toISOString();

  const concluidas = equipamentos.filter(e => e.statusPreventiva === 'Concluída').length;
  const andamento = equipamentos.filter(e => e.statusPreventiva === 'Em andamento').length;
  const pendentes = equipamentos.filter(e => e.statusPreventiva === 'Pendente').length;
  const execucao = equipamentos.length ? (concluidas / equipamentos.length * 100).toFixed(1) : '0.0';

  const historicoSeguro = historico || [];
  const concluidosSemana = historicoSeguro.filter(h =>
    h.statusNovo === 'Concluída' && h.registradoEm >= seteDiasAtrasISO
  ).length;
  const concluidosSemanaAnterior = historicoSeguro.filter(h =>
    h.statusNovo === 'Concluída' && h.registradoEm >= catorzeDiasAtrasISO && h.registradoEm < seteDiasAtrasISO
  ).length;
  
  const deltaSemana = concluidosSemana - concluidosSemanaAnterior;
  const deltaTexto = deltaSemana > 0 ? `▲ ${deltaSemana}` : deltaSemana < 0 ? `▼ ${Math.abs(deltaSemana)}` : `-`;

  const porSetor = {};
  equipamentos.forEach(e => {
    const setor = e.setorPCM || 'Não classificado';
    if (!porSetor[setor]) porSetor[setor] = [];
    porSetor[setor].push(e);
  });

  const atrasados = equipamentos.filter(e =>
    e.dataAgendada < hojeISO && e.statusPreventiva !== 'Concluída'
  );
  const atrasaramSemana = atrasados.filter(e => e.dataAgendada >= seteDiasAtrasData).length;

  let conteudoHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        /* Reset para evitar margens fantasma */
        * { box-sizing: border-box; }
        
        body {
          font-family: 'Segoe UI', Helvetica, Arial, sans-serif;
          margin: 30px;
          color: #1a1a1a;
          font-size: 11px;
          line-height: 1.4;
        }

        /* CABEÇALHO: Float ao invés de Flexbox */
        .header {
          width: 100%;
          border-bottom: 2px solid #2c3e50;
          padding-bottom: 15px;
          margin-bottom: 25px;
          overflow: hidden; /* Força o elemento a conter os floats */
        }
        .header-left { float: left; width: 60%; }
        .header-right { float: right; width: 40%; text-align: right; }
        
        .header-left h1 {
          font-size: 18px;
          text-transform: uppercase;
          margin: 0 0 5px 0;
          color: #2c3e50;
        }
        .header-left p { margin: 0; color: #555; font-size: 11px; }
        .header-right p { margin: 0 0 4px 0; color: #555; }

        /* KPI / RESUMO: Display Table ao invés de Flexbox */
        .summary-box {
          width: 100%;
          display: table;
          border: 1px solid #d2d6de;
          background-color: #fcfcfc;
          margin-bottom: 25px;
        }
        .summary-item {
          display: table-cell;
          width: 20%; /* 5 itens = 20% cada */
          text-align: center;
          vertical-align: middle;
          padding: 15px 10px;
          border-right: 1px solid #eee;
        }
        .summary-item:last-child { border-right: none; }
        
        .summary-label {
          font-size: 10px;
          color: #666;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 5px;
        }
        .summary-value {
          font-size: 20px;
          font-weight: bold;
          color: #2c3e50;
        }

        /* TÍTULOS DE SEÇÃO */
        .section-title {
          font-size: 13px;
          font-weight: bold;
          text-transform: uppercase;
          color: #2c3e50;
          border-bottom: 1px solid #d2d6de;
          padding-bottom: 5px;
          margin: 30px 0 15px 0;
          page-break-after: avoid; /* Evita quebra de página logo após o título */
        }

        /* TABELAS COM LARGURA FIXA */
        table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 20px;
          table-layout: fixed; /* Impede que colunas longas espremam as curtas */
        }
        th {
          background-color: #f4f6f8;
          color: #333;
          font-weight: bold;
          text-transform: uppercase;
          font-size: 10px;
          padding: 8px;
          border-bottom: 2px solid #d2d6de;
        }
        td {
          padding: 8px;
          border-bottom: 1px solid #eee;
          font-size: 11px;
          word-wrap: break-word;
        }
        
        /* ALINHAMENTOS UTILITÁRIOS */
        .text-center { text-align: center; }
        .text-right { text-align: right; }
        .text-left { text-align: left; }

        /* ETIQUETAS DE STATUS */
        .status-badge {
          padding: 3px 6px;
          border-radius: 3px;
          font-size: 10px;
          font-weight: bold;
          display: inline-block; /* Evita que a tag quebre de linha no meio */
        }
        .concluida { color: #1e7e34; background: #e8f5e9; }
        .andamento { color: #856404; background: #fff3cd; }
        .pendente { color: #c82333; background: #f8d7da; }
        
        .delta-pos { color: #1e7e34; font-weight: bold; }
        .delta-neg { color: #c82333; font-weight: bold; }
        
        .footer {
          margin-top: 40px;
          padding-top: 15px;
          border-top: 1px solid #d2d6de;
          font-size: 9px;
          color: #777;
          overflow: hidden;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="header-left">
          <h1>Relatório de Manutenção PMOC</h1>
          <p>Assembleia Legislativa do Estado do Ceará (ALECE)</p>
        </div>
        <div class="header-right">
          <p><strong>Emissão:</strong> ${dataFormatada}</p>
          <p><strong>Período:</strong> ${seteDiasAtras.toLocaleDateString('pt-BR')} a ${dataFormatada}</p>
        </div>
      </div>

      <div class="summary-box">
        <div class="summary-item">
          <div class="summary-label">Total de Equip.</div>
          <div class="summary-value">${equipamentos.length}</div>
        </div>
        <div class="summary-item">
          <div class="summary-label">Concluídas</div>
          <div class="summary-value">${concluidas}</div>
        </div>
        <div class="summary-item">
          <div class="summary-label">Pendentes</div>
          <div class="summary-value">${pendentes + andamento}</div>
        </div>
        <div class="summary-item">
          <div class="summary-label">Execução</div>
          <div class="summary-value">${execucao}%</div>
        </div>
        <div class="summary-item">
          <div class="summary-label">Avanço (7 dias)</div>
          <div class="summary-value">${concluidosSemana} OS</div>
          <div style="font-size: 9px; margin-top: 4px;" class="${deltaSemana > 0 ? 'delta-pos' : deltaSemana < 0 ? 'delta-neg' : ''}">
            ${deltaTexto} vs sem. anterior
          </div>
        </div>
      </div>

      <div class="section-title">1. Resumo por Setor de Atuação</div>
      <table>
        <thead>
          <tr>
            <th style="width: 40%;" class="text-left">Setor PCM</th>
            <th style="width: 12%;" class="text-center">Total</th>
            <th style="width: 12%;" class="text-center">Concluídas</th>
            <th style="width: 12%;" class="text-center">Andamento</th>
            <th style="width: 12%;" class="text-center">Pendentes</th>
            <th style="width: 12%;" class="text-right">Avanço</th>
          </tr>
        </thead>
        <tbody>
  `;

  Object.entries(porSetor).forEach(([setor, itens]) => {
    const setorConcluidas = itens.filter(e => e.statusPreventiva === 'Concluída').length;
    const setorAndamento = itens.filter(e => e.statusPreventiva === 'Em andamento').length;
    const setorPendentes = itens.filter(e => e.statusPreventiva === 'Pendente').length;
    const setorProgresso = (setorConcluidas / itens.length * 100).toFixed(0);

    conteudoHTML += `
      <tr>
        <td class="text-left"><strong>${setor}</strong></td>
        <td class="text-center">${itens.length}</td>
        <td class="text-center">${setorConcluidas}</td>
        <td class="text-center">${setorAndamento}</td>
        <td class="text-center">${setorPendentes}</td>
        <td class="text-right">${setorProgresso}%</td>
      </tr>
    `;
  });

  conteudoHTML += `
        </tbody>
      </table>

      <div class="section-title">2. Equipamentos com Vencimento Expirado</div>
  `;

  if (atrasados.length > 0) {
    const porEquipe = {};
    atrasados.forEach(e => {
      const equipe = e.equipeResponsavel || 'Não alocada';
      porEquipe[equipe] = (porEquipe[equipe] || 0) + 1;
    });

    conteudoHTML += `
      <p style="font-size: 10px; color: #555; margin-bottom: 15px;">
        <strong>Distribuição do passivo:</strong> ${
        Object.entries(porEquipe).map(([equipe, qtd]) => `${equipe} (${qtd})`).join(' | ')
      }</p>
      <table>
        <thead>
          <tr>
            <th style="width: 15%;" class="text-left">Patrimônio</th>
            <th style="width: 25%;" class="text-left">Setor</th>
            <th style="width: 25%;" class="text-left">Ambiente</th>
            <th style="width: 12%;" class="text-left">Equipe</th>
            <th style="width: 11%;" class="text-center">Prazo</th>
            <th style="width: 12%;" class="text-center">Status</th>
          </tr>
        </thead>
        <tbody>
    `;

    atrasados.forEach(eq => {
      const classeStatus = eq.statusPreventiva === 'Concluída' ? 'concluida'
        : eq.statusPreventiva === 'Em andamento' ? 'andamento'
        : 'pendente';

      const dataFormatadaStr = eq.dataAgendada ? eq.dataAgendada.split('-').reverse().join('/') : '-';

      conteudoHTML += `
        <tr>
          <td class="text-left">${eq.patrimonio || 'S/N'}</td>
          <td class="text-left">${eq.setor}</td>
          <td class="text-left">${eq.ambiente}</td>
          <td class="text-left">${eq.equipeResponsavel || '-'}</td>
          <td class="text-center">${dataFormatadaStr}</td>
          <td class="text-center"><span class="status-badge ${classeStatus}">${eq.statusPreventiva}</span></td>
        </tr>
      `;
    });

    conteudoHTML += `
        </tbody>
      </table>
    `;
  } else {
    conteudoHTML += '<p style="font-style: italic; color: #1e7e34;">Nenhuma não-conformidade de prazo detectada neste ciclo.</p>';
  }

  conteudoHTML += `
      <div class="footer">
        <div style="float: left;">Sistema de Manutenção Preventiva — Gerado automaticamente.</div>
        <div style="float: right;">Página 1</div>
      </div>
    </body>
    </html>
  `;

  return conteudoHTML;
}
