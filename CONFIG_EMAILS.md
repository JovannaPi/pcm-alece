Configuração de Notificações por Email

FUNCIONALIDADES IMPLEMENTADAS

1. Alertas Automáticos de Equipamentos Atrasados
   - Enviados diariamente às 8h (horário de Fortaleza)
   - Mostra equipamentos com manutenção atrasada
   - Enviado para todos os usuários cadastrados

2. Relatório Semanal em PDF
   - Enviado toda segunda-feira às 9h
   - Inclui: KPIs, resumo por setor, equipamentos atrasados
   - Formato: PDF formatado profissionalmente

3. Gráficos Avançados no Dashboard
   - Tendência de execução (7 meses)
   - Distribuição de status (pizza)
   - Equipamentos por setor (barra)
   - Taxa de execução (progresso)

CONFIGURAÇÃO DO FIREBASE

1. Crie um arquivo .env.local na raiz do projeto:
   EMAIL_USER=seu-email@gmail.com
   EMAIL_PASSWORD=sua-senha-de-app

2. Para Gmail, use Senha de App (não a senha comum):
   https://support.google.com/accounts/answer/185833

3. Deploy das Cloud Functions:
   firebase deploy --only functions

4. Configure as regras de Firestore para permitir leitura de usuarios:
   match /usuarios/{userId} {
     allow read, write: if request.auth.uid == userId;
   }

IMPLEMENTAÇÃO NO HTML

Adicione ao seu index.html dentro da view dashboard:

<div class="secao-graficos">
  <div class="grafico-container">
    <canvas id="graficoTendencia"></canvas>
  </div>
  <div class="grafico-container">
    <canvas id="graficoDistribuicao"></canvas>
  </div>
  <div class="grafico-container">
    <canvas id="graficoPorSetor"></canvas>
  </div>
  <div class="grafico-container">
    <canvas id="graficoProgresso"></canvas>
  </div>
</div>

ADICIONE AO SEU APP.JS

Importe as funções:
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/3.9.1/chart.min.js"></script>
<script src="utils/chartsConfig.js"></script>
<script src="utils/pdfGenerator.js"></script>

Quando carregar o dashboard, chame:
renderGraficoTendencia(ESTADO.equipamentos);
renderGraficoDistribuicao(ESTADO.equipamentos);
renderGraficoPorSetor(ESTADO.equipamentos);
renderGraficoProgresso(ESTADO.equipamentos);

Botão para Exportar PDF:
<button id="btnExportarPDF" class="btn primary">Exportar Relatório PDF</button>

Document.getElementById('btnExportarPDF').addEventListener('click', () => {
  baixarRelatorioPDF(ESTADO.equipamentos, ESTADO.cicloAtual);
});

DADOS NECESSÁRIOS NO FIRESTORE

Crie uma coleção usuarios com documentos contendo:
- email: string (email da pessoa)
- nome: string (nome do usuário)
- ativo: boolean (se recebe notificações)

Exemplo:
usuarios/user123 {
  email: "joana@email.com"
  nome: "Joana Ferreira"
  ativo: true
}

ESTRUTURA DE PASTAS

pcm-alece/
├── functions/
│   ├── sendEmails.js (Cloud Functions)
│   └── index.js (export das funções)
├── utils/
│   ├── chartsConfig.js (Gráficos)
│   └── pdfGenerator.js (Gerador PDF)
├── CONFIG_EMAILS.md (este arquivo)
└── app.js (modificar)

TESTE LOCAL

Para testar emails localmente sem deploy:
1. Use nodemailer em desenvolvimento
2. Configure as variáveis de ambiente
3. Dispare manualmente a função para testar

SUPORTE

Problemas comuns:

1. "Email não foi enviado"
   - Verifique as credenciais no .env.local
   - Confirme que Gmail permite apps menos seguros

2. "Gráficos não aparecem"
   - Incluiu Chart.js no HTML?
   - Chamou as funções renderGrafico*() ?

3. "PDF está vazio"
   - Há dados em ESTADO.equipamentos?
   - Incluiu a biblioteca html2pdf?

PRÓXIMAS MELHORIAS

- Webhook para notificações em Slack
- Integração com Google Calendar
- Modo offline com sincronização
- Personalização de horários de notificação
