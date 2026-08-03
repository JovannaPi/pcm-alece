# GUIA DE USO - PMOK ALECE

**Sistema de Manutenção Preventiva da Assembleia Legislativa do Estado do Ceará**

---

## Índice
1. [Login e Acesso](#login-e-acesso)
2. [Fluxo Principal](#fluxo-principal)
3. [Entendendo os Parâmetros](#entendendo-os-parâmetros)
4. [Usando o Sistema](#usando-o-sistema)
5. [FAQ](#faq)

---

## Login e Acesso

### Primeira Vez?

1. Acesse a aplicação
2. Clique em **"Criar uma conta nova"**
3. Preencha:
   - **Usuário**: seu nome (ex: `joana.feira`)
   - **Senha**: mínimo 6 caracteres
4. Pronto! Você está dentro

### Já Tem Conta?

1. Clique em **"Entrar"**
2. Digite seu usuário e senha
3. Acesso concedido!

---

## Fluxo Principal

O sistema funciona em 4 etapas:

```
┌─────────────────────────────────────────────┐
│ 1. LEVANTAMENTO                              │
│    Envie planilha com equipamentos           │
└────────────────┬────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────┐
│ 2. CRONOGRAMA                               │
│    Configure parâmetros e capacidade        │
└────────────────┬────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────┐
│ 3. CALENDÁRIO                               │
│    Visualize datas agendadas                │
└────────────────┬────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────┐
│ 4. DASHBOARD                                │
│    Acompanhe progresso e KPIs              │
└─────────────────────────────────────────────┘
```

---

## Entendendo os Parâmetros

### Aba "Levantamento" (Upload)

**O que fazer:**
1. Clique na área de drag-and-drop ou **"Clique ou arraste o arquivo aqui"**
2. Selecione um arquivo `.xlsx`, `.xls` ou `.csv`
3. O sistema carregará automaticamente

**Formato esperado:**
Seu arquivo precisa ter as colunas:
- **Setor** (obrigatório)
- **Ambiente** (obrigatório)
- **Patrimônio** (opcional, mas recomendado)
- **Status / ano** (opcional)

**Exemplo:**

| Setor | Ambiente | Patrimônio | Status |
|-------|----------|-----------|--------|
| Presidência | Sala de Reuniões | PRES-001 | Bom |
| TI/Racks | Sala de Servidores | TI-RACK-001 | Crítico |

---

### Aba "Cronograma" (Configuração)

#### Parâmetros Iniciais

**Dias úteis por semana**
- O que é: Quantos dias por semana sua equipe trabalha
- Exemplo: `5` = segunda a sexta
- Padrão: `5` dias
- Intervalo: 1-7

**Data de início**
- O que é: Quando o ciclo de manutenção começa
- Formato: YYYY-MM-DD (ex: 2025-01-15)
- O sistema ajustará automaticamente para o primeiro dia útil se cair em fim de semana/feriado

---

#### Capacidade por Prédio

**Por que configurar?**
O cronograma é distribuído de forma realista baseado na capacidade de trabalho de cada prédio.

**O que configurar:**
- **Número de Equipes**: Quantas equipes trabalham simultaneamente naquele prédio
- **Aparelhos por Dia**: Quantos equipamentos cada equipe consegue manter por dia

**Exemplo:**
- Prédio SEDE: 2 equipes × 3 aparelhos/dia = 6 aparelhos/dia
- Prédio ANEXO 1: 1 equipe × 2 aparelhos/dia = 2 aparelhos/dia

**Cálculo automático:**
```
Capacidade do Dia = (Nº de Equipes) × (Aparelhos por Dia)
```

---

### Aba "Calendário"

**Como funciona:**
- Mostra todos os equipamentos agendados
- Código de cores:
  - 🟢 **Verde** = Concluído
  - 🟡 **Amarelo** = Em andamento
  - 🔴 **Vermelho** = Pendente
  - ⚫ **Preto** = Atrasado

**O que fazer:**
1. Navegue pelos meses (botões < e >)
2. Clique em um dia para ver os equipamentos agendados
3. Clique em um equipamento para editar status

---

### Aba "Dashboard"

**Indicadores (KPIs):**
- **Equipamentos**: Total de itens no cronograma
- **Concluídas**: Manutenções já feitas
- **Em andamento**: Manutenções começadas
- **Pendentes**: Aguardando início

**Execução (%):**
```
Execução = (Concluídas + Em Andamento) / Total
```

---

## Usando o Sistema

### Passo 1️: Envie o Levantamento

1. Acesse a aba **"Levantamento"**
2. Prepare sua planilha com as colunas necessárias
3. Faça upload
4. O sistema classificará automaticamente cada equipamento por prioridade

### Passo 2️: Configure o Cronograma

1. Acesse a aba **"Cronograma"**
2. Defina:
   - Dias úteis por semana
   - Data de início
   - Capacidade por prédio
3. Clique em **"Gerar Cronograma"**
4. Aguarde a confirmação

### Passo 3️: Visualize no Calendário

1. Acesse a aba **"Calendário"**
2. Navegue pelos meses
3. Veja os equipamentos agendados por data
4. Clique em um equipamento para editar status

### Passo 4️: Acompanhe no Dashboard

1. Acesse a aba **"Dashboard"**
2. Veja o progresso em tempo real
3. Exporte relatórios em Excel
4. Identifique atrasos e ajuste

---

## Gerenciando Feriados e Férias

### Adicionar um Feriado

1. Acesse a aba **"Feriados e férias"**
2. Clique em **"Novo Feriado"**
3. Preencha:
   - **Data**: Quando o feriado é
   - **Label**: Nome (ex: "Natal")
   - **Tipo**: Feriado ou Férias
4. Clique **"Salvar"**

### O que acontece?

Automaticamente o sistema:
- Reagenda equipamentos que caem naquele dia
- Avança para o próximo dia útil disponível
- Mantém a ordem e capacidade respeitadas

---

## Gerenciando Usuários e Permissões

### Como Administrador

1. Clique no ⚙️ no canto superior direito
2. Acesse **"Configurações"** → **"Usuários"**
3. Veja todos os usuários cadastrados
4. (Futuramente) Defina permissões por usuário

### Tipos de Permissão

- **Admin**: Acesso total ao sistema
- **Leitor**: Apenas visualiza (read-only)

---

##  Exportando Dados

### Gerar Relatório em Excel

1. Acesse **"Dashboard"**
2. Procure pelo botão **"Exportar Excel"** ou similar
3. O sistema gera uma planilha com:
   - Resumo executivo (KPIs)
   - Tabela com todos os equipamentos
   - Gráficos de progresso
   - Separação por prédio e setor

### Estrutura do Excel

O relatório exportado contém:
- **Aba 1 - Resumo**: KPIs e indicadores
- **Aba 2 - Dados**: Todos os equipamentos com status
- **Aba 3 - Análise**: Gráficos e distribuições

---

##  FAQ

### P: Posso editar um equipamento depois de gerar o cronograma?

**R:** Sim! Acesse **"Equipamentos"**, encontre o item e clique para editar:
- Status da preventiva
- Data agendada
- Observações

---

### P: E se eu adicionar um feriado depois que o cronograma já foi gerado?

**R:** Não se preocupe! O sistema **reagenda automaticamente** todos os equipamentos que caem naquele feriado, mantendo tudo organizado.

---

### P: Como vejo equipamentos que estão atrasados?

**R:** 
- No **Calendário**: Equipamentos com badge preta estão atrasados
- No **Dashboard**: Seção "Atrasos" mostra histórico de reagendamentos
- Há um **banner vermelho** no topo alertando sobre atrasados

---

### P: Posso reagendar manualmente um equipamento?

**R:** Sim! 
1. Acesse **"Equipamentos"**
2. Encontre o item
3. Clique no ⋯ (menu de ações)
4. Selecione "Reagendar"
5. Escolha a nova data

---

### P: O que significa "Capacidade por Prédio"?

**R:** É quantos equipamentos sua equipe consegue manter simultaneamente.

Exemplo:
- Se tem **2 equipes** e cada uma consegue fazer **3 aparelhos/dia**
- A capacidade é **6 equipamentos por dia** naquele prédio
- O cronograma distribuirá respeitando esse limite

---

### P: Posso ter equipes diferentes por prédio?

**R:** Sim! Configure a capacidade individualmente para cada prédio (SEDE, ANEXO 1, etc.).

---

### P: O sistema funciona offline?

**R:** Não. O PMOK ALECE precisa de internet para sincronizar dados com o Firebase.

---

### P: Onde estão meus dados salvos?

**R:** Seus dados estão em um banco de dados na nuvem (Firebase Firestore). Eles são:
- Sincronizados em tempo real
- Automaticamente backup
   Acessíveis de qualquer navegador

---

##  Suporte

Se encontrar problemas:

1. Verifique sua conexão com internet
2. Faça refresh da página (F5)
3. Abra o console (F12) e procure por erros em vermelho
4. Tente em outro navegador moderno

---

##  Dicas Práticas

 **Ao começar:**
- Comece com um pequeno grupo de equipamentos para testar
- Ajuste os parâmetros conforme necessário

 **Durante a operação:**
- Verifique o Dashboard diariamente
- Reagende atrasados no mesmo dia

 **Manutenção:**
- Faça backup exportando Excel regularmente
- Mantenha a lista de feriados atualizada

