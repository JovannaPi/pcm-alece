#  PMOK ALECE

**Sistema de Manutenção Preventiva da Assembleia Legislativa do Estado do Ceará**

## Descrição

O PMOK ALECE é uma aplicação web inteligente para gerenciar cronogramas de manutenção preventiva em equipamentos. O sistema:

- 📊 **Classifica automaticamente** equipamentos por prioridade (Presidência, TI, Plenário, etc.)
- 🗓️ **Gera cronogramas** inteligentes respeitando capacidade de equipes e feriados
- 📈 **Acompanha progresso** com dashboard em tempo real
- 💾 **Sincroniza dados** automaticamente na nuvem (Firebase)
- 📤 **Exporta relatórios** em Excel com KPIs e análises

---

##  Como Usar

### 1️ Acesse a Aplicação

```
https://seu-dominio.com/pcm-alece
```

### 2️ Faça Login

- Primeira vez? Clique em **"Criar uma conta nova"**
- Já tem conta? Use **"Entrar"**

### 3️ Siga o Fluxo

```
Levantamento → Cronograma → Calendário → Dashboard
```

**Leia o [GUIA.md](./GUIA.md) para instruções detalhadas.**

---

##  Funcionalidades Principais

| Funcionalidade | Descrição |
|---|---|
| **Upload de Planilhas** | Suporta .xlsx, .xls e .csv |
| **Classificação Automática** | Identifica setor por descrição com regex |
| **Geração de Cronograma** | Algoritmo inteligente com distribuição por capacidade |
| **Calendário Interativo** | Visualiza agendamentos com filtros por prédio |
| **Dashboard com KPIs** | Mostra progresso, concluídas, pendentes e em andamento |
| **Gerenciamento de Feriados** | Adiciona feriados que reagendam automaticamente |
| **Integração com Corretivas** | Carrega dados de Google Sheets a cada 5 min |
| **Histórico de Auditoria** | Registra todas as ações com timestamp |
| **Exportação Excel** | Gera relatórios formatados e profissionais |

---

##  Tecnologias

- **Frontend:** Vanilla JavaScript (ES6+)
- **Backend:** Firebase (Firestore + Authentication)
- **Dados:** Excel (XLSX, ExcelJS)
- **Estilos:** CSS3 responsivo
- **Deploy:** Static hosting (Firebase, Vercel, etc.)

---

##  Estrutura de Arquivos

```
pcm-alece/
├── app.js                      # Lógica principal (3.771 linhas)
├── index.html                  # Interface web
├── styles.css                  # Estilos
├── firebase-config.js          # Configuração Firebase
├── GUIA.md                     # Documentação de uso
├── MODELO_PLANILHA.csv         # Exemplo de dados
├── README.md                   # Este arquivo
└── site-header-mobile.png      # Logo da ALECE
```

---

##  Segurança

-  Autenticação obrigatória via Firebase Auth
-  Dados sincronizados e criptografados
-  Sem permissão de acesso antes do login
-  Credenciais Firebase expostas no código (necessário para apps públicas)

---

##  Fluxo de Dados

```
User → Upload Planilha → Classificação → Cronograma → Firebase
                              ↓              ↓           ↓
                         Categoriza    Distribui    Sincroniza
                         por setor     por data     em tempo real
                              ↓              ↓           ↓
                         Calendário → Dashboard ← KPIs e Relatórios
```

---

##  Parâmetros Configuráveis

### Cronograma

- **Dias úteis por semana:** 1-7 (padrão: 5)
- **Data de início:** YYYY-MM-DD
- **Ciclo de manutenção:** 4 meses (configurável)
- **Capacidade por prédio:** Equipes × Aparelhos/dia

### Integração

- **URL Corretivas:** Google Sheets CSV exportado
- **Intervalo de atualização:** 5 minutos
- **Prédios:** SEDE, ANEXO 1, ANEXO 2, etc. (configuráveis)

---

## 📈KPIs e Métricas

O dashboard mostra:

-  **Total de equipamentos**
-  **Concluídas** (quantidade e %)
-  **Em andamento** (quantidade e %)
-  **Pendentes** (quantidade e %)
-  **Taxa de execução** (% conclusão)
-  **Equipes envolvidas**
-  **Prédios atendidos**

---

##  Problemas Conhecidos

Nenhum bug crítico identificado. Consulte a [análise de código](./ANALISE_CODIGO.md) para detalhes.

---

##  Melhorias Futuras

- [ ] Offline mode com Service Worker
- [ ] Testes automatizados
- [ ] Dark mode
- [ ] Suporte a múltiplos idiomas
- [ ] API REST para integração externa
- [ ] Notificações por email/SMS

---

##  Suporte

-  **Documentação:** Veja [GUIA.md](./GUIA.md)
-  **Reportar bugs:** Abra uma issue no GitHub
-  **Dúvidas:** Entre em contato com o time

---

##  Licença

Desenvolvido para a Assembleia Legislativa do Estado do Ceará.

---

##  Desenvolvimento

### Stack de Desenvolvimento

```bash
# Dependências
- Firebase SDK 10.12.2
- XLSX 0.18.5
- ExcelJS 4.4.0

# Sem build tool necessário — vanilla JS
```

### Como Contribuir

1. Clone o repositório
2. Crie uma branch: `git checkout -b feature/sua-feature`
3. Faça commit das alterações
4. Push para a branch: `git push origin feature/sua-feature`
5. Abra um Pull Request

---

**Versão:** 2.0  
**Última atualização:** Janeiro/2025  
**Mantido por:** Time de Desenvolvimento ALECE
