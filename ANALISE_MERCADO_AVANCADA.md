# GiroCerto — Análise de Mercado Avançada (Pente Fino)

Continuação de [`ANALISE_MERCADO_E_TORRE.md`](./ANALISE_MERCADO_E_TORRE.md) (16/08/2026),
que já mapeou concorrentes diretos brasileiros e o cruzamento com o Torre. Este documento
**não repete** os 7 pontos fortes nem os 11 gaps já identificados lá — trata aquele
documento como baseline e vai mais fundo em fontes que não tinham sido cobertas: redes
sociais, comunidades/fóruns, blogs de engenharia de players internacionais, sites de
review, literatura acadêmica e mercados emergentes fora do Brasil.

**Nota metodológica e limitação honesta:** não há como "navegar" feeds do LinkedIn/
Instagram/TikTok diretamente sem autenticação — as buscas abaixo usam conteúdo público
indexado (cobertura de imprensa sobre declarações de founders/CEOs, posts que viraram
notícia, arquivos de blog técnico público). Quando uma fonte da lista pedida ficou
genuinamente inacessível ou sem achado relevante, isso está marcado explicitamente
abaixo em vez de preenchido com suposição. G2/Reddit tiveam cobertura mais fraca que o
esperado (resultados genéricos de marketing, não threads de usuário reais) — o achado
mais forte de "dor real" veio de Reclame Aqui e de reportagem sobre um post viral no
Reddit (contextualizado como estudo de caso de confiança, não como fonte de produto).

---

## 1. Inovações genuinamente recentes (últimos 12 meses) — ainda não é padrão de mercado

**1.1 iFood lançou escolha de rota pelo entregador, não só despacho automático puro
(abril/2026).** "Rotas Disponíveis": o motoboy abre o app, vê uma lista de pedidos
próximos com valor visível e escolhe qual pegar, em vez de só receber uma oferta
única aceitar/recusar. iFood reporta 70% de retorno de uso entre quem testou. Isso é
uma inversão parcial de controle: em vez de o algoritmo decidir sozinho quem pega o
quê, o motoboy ganha visibilidade e escolha dentro de um conjunto filtrado (proximidade,
tipo de veículo, se precisa de maquininha). ([iFood — lança recurso para escolha de
rotas](https://institucional.ifood.com.br/releases/ifood-lanca-recurso-para-escolha-de-rotas/),
[TI Inside](https://tiinside.com.br/08/04/2026/ifood-lanca-recurso-para-escolha-de-rotas/))

**1.2 DoorDash reformulou o motor de despacho pra um problema de otimização explícito
(MIP), não só ranking por score (abr/2025 em diante).** O sistema pontua e ranqueia
ofertas via *mixed-integer program* resolvido com Gurobi, buscando equilíbrio entre
eficiência (menos km rodado, menos tempo ocioso do entregador) e qualidade (comida
chega quente, cliente não espera demais) — não é só "manda pro mais próximo".
([DoorDash Engineering — Using ML and Optimization to Solve DoorDash's Dispatch
Problem](https://careersatdoordash.com/blog/using-ml-and-optimization-to-solve-doordashs-dispatch-problem/),
[Next-Generation Optimization for Dasher Dispatch](https://careersatdoordash.com/blog/next-generation-optimization-for-dasher-dispatch-at-doordash/))

**1.3 Transparência algorítmica virou obrigação legal formal, não só boa prática —
Califórnia, em vigor desde 01/jan/2026 (AB-578).** A lei exige que apps de entrega
mostrem ao entregador um **extrato itemizado** do pagamento de cada corrida (pagamento
base + gorjeta + bônus promocional, separados), e proíbe usar valor de gorjeta pra
"completar" o pagamento base artificialmente. Isso é relevante direto pro GiroCerto:
o schema já calcula os componentes (`valor_entrega`, bônus de espera excedente, km
adicional) mas nada nos mockups **mostra esse detalhamento pro entregador** — ele só
vê o total (`t_ganho`). ([California AB-578 — texto da
lei](https://leginfo.legislature.ca.gov/faces/billNavClient.xhtml?bill_id=202520260AB578),
[cobertura — Tasting Table](https://www.tastingtable.com/2069543/new-california-law-food-delivery-app-refunds-2026/))

**1.4 Uber publicou um "Algorithmic Transparency Report" formal nos EUA em 2026** —
relatório dedicado a explicar, em linguagem pública, como os algoritmos de despacho e
precificação funcionam. É sintoma da mesma pressão regulatória/de confiança: bater de
frente com a opacidade virou estratégia de reputação, não só obrigação. ([Uber —
Algorithmic Transparency Report US
2026](https://tb-static.uber.com/prod/uber-static/uber-sites/_pdf/ai-on-uber/US-Algorithmic-Transparency-2026.pdf))

**1.5 "Algorithmic dignity" como framework de design, não só crítica acadêmica
abstrata.** Revisão sistemática recente propõe 3 pilares concretos e implementáveis:
transparência de critério (por que fui desativado/reprovado, como meu ganho foi
calculado), participação (trabalhador pode contestar/opinar sobre mudança de regra), e
design com cuidado (prazo realista, botão de pausa). O ponto prático: a literatura cita
"dar um botão de pausa pro entregador" como intervenção de baixo custo com efeito real
em estresse/segurança — o GiroCerto **acabou de implementar exatamente isso** nesta
sessão (fluxo de pausa/retomar turno), o que é uma validação externa post-hoc útil, não
um novo item de trabalho. ([Frontiers in Sociology — Algorithmic management in the
global gig economy](https://www.frontiersin.org/journals/sociology/articles/10.3389/fsoc.2026.1743445/full))

---

## 2. Dores reais de usuários finais — gap que nenhum concorrente pesquisado resolveu

**2.1 Atraso de repasse de 30 a 90 dias é queixa recorrente e específica de apps de
motoboy brasileiros (não só atraso genérico).** Reclamações reais no Reclame Aqui
contra Motoboy.com e Master Delivery Express mostram um padrão: solicitação de
fechamento só pode ser feita 30 dias após a corrida, **mais** 30 dias de prazo de
pagamento — na prática até 90 dias de espera, com relatos de dificuldade real de pagar
contas nesse meio-tempo. O GiroCerto já ataca isso estruturalmente com
`frequencia_repasse` (por_entrega ou fim_de_turno) — nenhum concorrente pesquisado
oferece repasse por entrega individual como opção padrão; a maioria trata "acúmulo e
fecha depois" como o único modelo. ([Reclame Aqui — Motoboy.com, atraso absurdo no
repasse](https://www.reclameaqui.com.br/motoboy-com/atraso-absurdo-no-repasse_gLyvezI0TOAxrxKG/),
[Reclame Aqui — Master Delivery
Express](https://www.reclameaqui.com.br/master-delivery-express-1/atraso-no-pagamento-e-falta-de-compromisso-com-motoboy-autonomo_VJfj7_YlVoJl4tJb/))

**2.2 Falsa confirmação de entrega ("deu baixa e sumiu com o pedido") é queixa real e
recorrente contra o iFood.** Vários relatos no Reclame Aqui de motoboy marcando pedido
como entregue sem entregar, sem reembolso automático. O GiroCerto já cobre isso melhor
estruturalmente — `comprovantes_entrega.codigo_confirmado` exige o cliente informar o
código que só ele recebeu, não é autoatestado pelo motoboy — mas vale confirmar (via
teste real, Parte B) que **não existe nenhum caminho no app pra marcar `entregue` sem
esse código confirmado**, porque é exatamente esse buraco que gera a reclamação nos
concorrentes. ([Reclame Aqui — motoboy deu baixa na entrega e
sumiu](https://www.reclameaqui.com.br/ifood/motoboy-deu-baixa-na-entrega-sumiu-com-meu-pedido_rBlk3xMWxgqIwA38/))

**2.3 Cancelamento estratégico de corrida "pra pegar uma melhor depois" gera cobrança
indevida ao cliente — queixa contra a Uber.** Padrão: motoboy aceita, começa a corrida
pro sistema achar que está em andamento, cancela na prática, e o cliente é cobrado por
algo que não aconteceu. É um gap de design (o sistema confia no status declarado do
entregador sem verificação cruzada). Não achei nenhum concorrente com proteção
publicamente documentada contra isso. Pro GiroCerto: `rotas_entrega.status` +
`tentativas_despacho` já registram quem aceitou/recusou, o que ajuda auditoria, mas
vale considerar se cancelamento tardio (depois de aceito, antes de `iniciada_em`)
deveria gerar penalidade/registro visível, não só ficar mudo no histórico. ([Reclame
Aqui — Uber, motoboys cancelam pra ganhar
taxa](https://www.reclameaqui.com.br/uber/motoboys-cancelam-entrega-da-uber-para-ganhar-taxa-gerando-cobrancas-indevidas-e-atraso-na-entrega_c7D_9Pn46jBSiffn/))

**2.4 A ansiedade sobre "o algoritmo está manipulando meu pagamento" é uma dor real e
generalizada — mesmo quando é boato.** Um post anônimo no Reddit alegando que um app
de entrega usa um "índice de desespero" (penaliza quem aceita corridas ruins,
escondendo as boas de quem "precisa menos") viralizou com 87 mil upvotes e dezenas de
milhões de visualizações antes de ser desmentido como boato (evidência gerada por IA).
O CEO da DoorDash teve que sair publicamente pra negar. **O boato pegou porque a dor é
real, mesmo que o caso específico não fosse verdade** — é o tipo de desconfiança que um
app pequeno e regional pode neutralizar de forma que um gigante não consegue (ver seção
4). ([PR Daily — The Scoop: A Reddit hoax went
viral](https://www.prdaily.com/the-scoop-a-reddit-hoax-went-viral-then-doordash-and-uber-eats-fired-back-2/),
[Fortune — DoorDash CEO blasts Reddit post
claim](https://fortune.com/2026/01/06/doordash-ceo-tony-xu-blasts-reddit-post-driver-claim/))

**2.5 Pesquisa de campo real (mestrado USP, prêmio de melhor dissertação
2025): entregador pedalando 6 meses documentou risco de vida direto ligado a prazo
apertado do algoritmo, sem margem pra prudência — "é terra de ninguém".** Isso não é
opinião de terceiro, é etnografia. Reforça (com peso acadêmico, não só anedota) o
próprio argumento que `tempo_espera_tolerado_min`/`segundos_timeout_despacho` do
GiroCerto já tentam mitigar — mas o achado novo aqui é que o problema central citado
não é falta de tempo de espera na loja, é falta de margem no trajeto/trânsito em si,
algo que o GiroCerto ainda não modela (não há campo de "tempo de deslocamento com
margem de segurança", só `tempo_deslocamento_loja_min` calculado via OSRM, presumidamente
sem folga). ([Portal Tio Sam — pesquisador pedalando como entregador de app por 6
meses](https://www.tiosam.com/noticias/internacionais/o-que-pesquisador-descobriu-pedalando-como-entregador-de-apps-por-6-meses-e-terra-de-ninguem-risco-de-vida-o-tempo-todo/))

**2.6 Motociclistas concentraram 40% das mortes no trânsito do Distrito Federal em
2026 (37 de 94 até junho).** Dado regional novo, mais grave que a estatística nacional
já citada no documento anterior — reforça que segurança viária (não só segurança
pessoal contra assalto) é uma frente de risco tão relevante quanto SOS/desvio de rota,
e o GiroCerto hoje não tem nenhum mecanismo que endereça risco de trânsito
especificamente (só risco de "parado"/"desviou"/"SOS manual"). ([Sou Brasília —
entregadores de app no DF correm contra o algoritmo e contra o
risco](https://soubrasilia.com/entregadores-aplicativo-df-algoritmo-mortes-transito-2026/))

---

## 3. Padrões de outras verticais adaptáveis

**3.1 Selo de prevenção a fraude auditado por terceiro, não autodeclarado (fintech
brasileiro).** A Fin (entidade que reúne bancos/fintechs/instituições de pagamento)
certifica instituições com um "Selo de Prevenção a Fraudes" — 22 instituições
certificadas, processo de auditoria, não é a própria empresa que se autodeclara segura.
Padrão adaptável: o "Selo Entrega Justa" do GiroCerto já é bem desenhado (calculado,
não autodeclarado, com volume mínimo), mas é *interno* — não existe hoje um selo
equivalente do lado do **cadastro/verificação do entregador**, voltado pra tranquilizar
a loja (e pro golpe do falso motoboy, já mapeado no documento anterior). Ver item 4.2.
([Finsiders Brasil — Fin certifica 22 instituições com Selo de Prevenção a
Fraudes](https://finsidersbrasil.com.br/noticias-sobre-fintechs/fraudes/fin-certifica-22-bancos-fintechs-e-cooperativas-com-selo-de-prevencao-a-fraudes/))

**3.2 Reputação com janela recente, não média vitalícia (Mercado Livre).** O algoritmo
de reputação do Mercado Livre pesa fortemente as últimas transações (janela de 60
dias), não a média histórica completa — assim um vendedor não vive pra sempre da boa
reputação antiga, e também não fica preso pra sempre a um problema pontual já corrigido.
O GiroCerto **já faz exatamente isso** na view `selo_entrega_justa` (janela de 30 dias)
— não é um gap, é confirmação externa de que o desenho já escolhido é o padrão correto
do setor de reputação/confiança, vindo de um player que testou isso em escala. Vale só
como validação, não como item de ação. ([Nubimetrics — Reputação no Mercado
Livre](https://academia.nubimetrics.com/br/reputacao-mercado-livre))

**3.3 Safety Toolkit da Uber: localização + dados do veículo compartilhados
digitalmente com quem atende a emergência, e follow-up humano proativo depois.**
Quando o SOS é acionado, o sistema já entrega pro atendente (ou nos EUA, direto pro
911 digitalmente) localização GPS, modelo do veículo e placa — sem precisar o usuário
descrever isso em pânico. Depois, o suporte faz um check-in de acompanhamento pra
confirmar que a pessoa está bem. O `alertas_seguranca` do GiroCerto já tem o fluxo de
confirmação humana (`aguardando_confirmacao` → `confirmado_ok`/`escalado_loja` →
`acionado_190`), mas não fica claro se o momento do SOS **empacota automaticamente** os
dados que quem for ligar pra polícia precisaria (posição, veículo, placa do
`entregadores`) — vale conferir/gerar esse pacote pronto no momento do alerta, não só
o tipo do alerta. ([Uber — Ubers Emergency Button and the technologies behind
it](https://www.uber.com/en-IN/blog/ubers-emergency-button-and-the-technologies-behind-it/))

**3.4 Contraexemplo — "Upfront Fares" da Uber é um alerta de cautela, não um padrão a
copiar.** Uber mostra o valor da corrida antes de aceitar (parece transparência), mas
pesquisa independente aponta que o *take rate* real subiu de ~32% pra ~42% desde a
mudança, e o quanto o motorista efetivamente recebe varia de 51% a 78% dependendo da
cidade — sem nunca mostrar esse percentual. **Transparência de número sem transparência
de fórmula é pior que não ter transparência nenhuma**, porque parece honestidade mas
esconde a métrica que importa (quanto fica pra plataforma vs. pro entregador). Isso é
um argumento a favor do item 4.1 abaixo ser feito com rigor (mostrar a fórmula
completa, não só o total), não pela metade. ([Ride Share Guy — Uber Finally Comes
Clean With Take Rates?](https://therideshareguy.com/uber-finally-comes-clean-with-take-rates-more-transparency/),
[gotaprob — Uber driver fare transparency
gap](https://www.gotaprob.com/problems/uber-driver-fare-transparency-gap))

---

## 4. Tendências regulatórias emergentes (além de NR-1 / Lei 14.297/2022 / Contran)

**4.1 Votação da regulamentação federal de apps prometida até abril/2026 — e o
impasse central é quase idêntico ao modelo de tarifa que o GiroCerto já usa.** Segundo
o presidente da Câmara, Hugo Motta, a votação do projeto que regulamenta trabalho por
app estava prevista até abril/2026; o texto ainda tramita em comissão especial. O
principal ponto de impasse entre entregadores e plataformas é uma **tarifa mínima de
R$10 + R$2,50 por km rodado**. Isso é notavelmente próximo do default atual do
GiroCerto: `tarifa_minima = R$10,00` (idêntico) e `valor_por_km_adicional = R$2,00`
(R$0,50 abaixo do piso em discussão). Vale decidir conscientemente se o default deveria
subir pra R$2,50 agora — não porque a lei já exige, mas porque se ela passar como está
sendo negociada, ficar abaixo do piso legal por default vira problema de compliance
imediato pro tenant que nunca mexeu na configuração. ([Portal de Prefeitura —
regulamentação ganha data pra
votação](https://portaldeprefeitura.com.br/bastidores-da-politica/regulamentacao-aplicativos-de-entrega-e-transporte-votacao/616840/))

**4.2 Precedente internacional concreto de lei específica sobre transparência de
pagamento — Califórnia AB-578, em vigor desde 01/jan/2026.** Já citada no item 1.3.
Relevância regulatória: não existe (ainda) equivalente brasileiro específico sobre
"extrato itemizado obrigatório", mas é o tipo de exigência que tende a aparecer depois
nos EUA e ser referenciada em discussões regulatórias locais — antecipar isso como
prática voluntária (ver diferencial 4.1 na seção 5) é mais barato agora do que como
retrofit sob prazo legal depois. ([Bill Text — AB-578 Food delivery platforms: customer
service](https://leginfo.legislature.ca.gov/faces/billNavClient.xhtml?bill_id=202520260AB578))

---

## 5. Mercados emergentes fora do Brasil — inovação sob restrição de infraestrutura

**5.1 Nigéria (Gokada): banimento regulatório forçou pivô de mototáxi pra logística —
e o diferencial que emergiu foi disciplina/previsibilidade, não velocidade.** Em 2020 o
governo de Lagos baniu mototáxi comercial por segurança; a Gokada pivotou pra entrega
de encomendas (Gsend) com a mesma frota. O relato do próprio pivô é explícito: o
produto virou "treinamento, disciplina do entregador, rastreio ao vivo, horário de
entrega previsível" como a nova proposta de valor central — não corrida mais rápida.
Isso é validação direta e independente (mercado completamente diferente, mesma pressão
estrutural) da tese central do GiroCerto: em mercado de última milha saturado, a
diferenciação sustentável é previsibilidade/confiança, não velocidade. ([Verito Digital
— About Gokada, pivot from ride-hailing to
logistics](https://veritodigital.com/gokada-pivot-from-ride-hailing-to-logistics/))

**5.2 México (99minutos): a própria tese de mercado do maior player de última milha
regional é "velocidade parou de ser o ponto".** Título de uma análise de mercado
dedicada especificamente a esse player: *"Why Speed Stopped Being the Point in LatAm
Last-Mile Delivery"*. Mesmo em um mercado que cresceu literalmente vendendo entrega em
menos de 99 minutos, a evolução observada é pra métricas de confiabilidade e
previsibilidade como o novo campo de disputa — segundo achado independente que reforça
o mesmo ponto do item 5.1, agora numa América Latina culturalmente mais próxima do
Brasil. ([Americas Market Intelligence — Why Speed Stopped Being the Point in LatAm
Last-Mile Delivery](https://americasmi.com/insights/99minutos-scaling-last-mile-latam/))

**5.3 Índia: literatura acadêmica recente propõe o conceito de "gestor
algorítmico-humano" — nem todo controle é automatizado, e essa mistura é o que
realmente acontece na prática.** Paper de 2026 sobre a gig economy indiana (setor
"blue-collar", equivalente direto ao motoboy) documenta que o controle real do
trabalhador é híbrido: parte algoritmo, parte supervisor humano informal reforçando as
regras do app. É um contraponto útil ao discurso de "tudo é o algoritmo" — sugere que
onde o GiroCerto tem decisão humana explícita e registrada (`aprovado_por`,
confirmação humana antes de escalar segurança) já está estruturalmente mais avançado
que o padrão real observado, não é só teoria. ([arXiv — The Algorithmic-Human Manager:
AI, Apps, and Workers in the Indian Gig
Economy](https://arxiv.org/abs/2606.19975v1))

---

## 6. Diferenciais potenciais — nenhum concorrente pesquisado tem

Aplicando o mesmo critério cético já usado no documento anterior pra descartar
gamificação: um diferencial só entra aqui se (a) resolver uma dor real documentada
acima, com fonte, e (b) não for trivialmente copiável em 2 semanas por um concorrente
médio — ou, se for copiável tecnicamente, exigir do concorrente abrir mão de algo que
ele estruturalmente não quer abrir mão (ex: mostrar margem real).

| # | Diferencial | Esforço | Defensabilidade de marca | Por quê |
|---|---|---|---|---|
| 6.1 | **Extrato de ganhos por entrega, com fórmula completa visível** (base + espera excedente + km adicional, não só total) | **Baixo** — dado já existe no schema, falta só UI no app do entregador | **Alta** — contra-narrativa direta ao "desperation score"/opacidade que é hoje um nervo global exposto (item 2.4); só é copiável de verdade se o concorrente aceitar expor a própria margem, o que grandes plataformas evitam estruturalmente (item 3.4) | Único item da lista com prova de que a dor é generalizada (viralizou globalmente mesmo sendo boato) |
| 6.2 | **Selo de verificação de entregador, público pra loja** (empacotar `status_verificacao`/histórico de aprovação como selo visível, não só processo interno) | **Baixo-Médio** — dado já existe (`status_verificacao`, `motivo_reprovacao`, prazo de 7 dias), falta exibição pública + naming | **Média-Alta** — ataca o golpe do falso motoboy (já mapeado no doc anterior) com prova social auditável, seguindo o padrão de selo de terceiro-confiável do setor fintech (item 3.1), não autodeclaração | Um concorrente pode *dizer* que verifica; copiar o rigor real (prazo de 7 dias, motivo estruturado, aprovação humana registrada) é mais difícil que copiar o selo em si |
| 6.3 | **Canal de contestação de reprovação/bloqueio, com resposta humana registrada** | **Médio** — precisa de novo fluxo (status "contestado", campo de resposta do dono/dado ao entregador), não só UI | **Alta** — é o oposto estrutural do "desativação algorítmica sem explicação nem recurso" documentado como fonte de desconfiança na literatura (item 1.5); nenhum concorrente pesquisado documenta publicamente ter isso | Exige mudança de processo interno do concorrente, não só de tela — mais difícil de copiar rápido que um recurso de UI |
| 6.4 | **Posicionamento de marca explícito: "previsibilidade, não velocidade"** | **Muito baixo** — é discurso/copy consistente com o que já foi construído (tarifa fixa, espera remunerada, sem precificação dinâmica), não é código novo | **Alta, condicional** — validado de forma independente em 2 mercados diferentes (Nigéria item 5.1, México item 5.2) como a direção de diferenciação real do setor, não papo de marketing. **Mas** só é defensável se for consistente: se o produto no fundo empurrar velocidade em algum lugar (ex: um futuro ETA "otimista" pra parecer mais rápido), a marca desmorata sozinha — mesmo risco que fez o documento anterior descartar gamificação por contradizer o Selo Entrega Justa | Barato de fazer, caro de trair depois — por isso a defensabilidade é condicional, não automática |
| 6.5 | **Pacote de dados de emergência pronto no momento do SOS** (posição + veículo + placa do entregador, empacotado automaticamente pra quem for acionar ajuda) | **Baixo** — dado já existe em `entregadores`/`localizacoes_entregador`, falta só a função que monta o pacote no momento do alerta | **Média** — é boa prática já validada (item 3.3), mas é mais feature operacional do que diferencial de marca por si só; vale fazer por ser certo, não por ser exclusivo | Sozinho não é diferencial de marca forte, mas é pré-requisito prático pra qualquer comunicação de marketing sobre segurança ser honesta |

**O que NÃO entra aqui, com o mesmo ceticismo:** IA de detecção de burnout via análise
de voz/e-mail (item da pesquisa, seção "tendências") é tecnicamente possível mas
estruturalmente hostil ao mesmo pilar de confiança que sustenta os itens acima —
monitorar tom de voz do entregador é vigilância, não cuidado, e contradiz na prática o
discurso de "algorithmic dignity" que justifica os outros itens. Mesmo padrão de
descarte já aplicado à gamificação no documento anterior.

---

## Recomendação de priorização (top 4)

1. **6.1 — Extrato de ganhos detalhado.** Maior retorno por menor esforço da lista:
   dado já existe, é uma tela nova no app do entregador, e ataca a dor mais bem
   documentada e mais universal encontrada nesta pesquisa (item 2.4). Fazer com rigor
   (fórmula completa, não só total bonito) — ver o contraexemplo do item 3.4 antes de
   implementar, pra não cair na armadilha de "transparência decorativa".
2. **6.2 — Selo de verificação pra loja.** Segundo maior retorno por esforço: dado
   pronto, resolve um medo real (golpe do falso motoboy) que já estava mapeado no
   documento anterior mas sem solução proposta até agora.
3. **4.1 — Revisar `valor_por_km_adicional` default à luz do piso em negociação
   (R$2,50/km).** Não é feature, é ajuste de configuração/decisão consciente — mas o
   timing importa (antes da lei passar é decisão de produto; depois é reação a
   compliance).
4. **6.3 — Canal de contestação de reprovação.** Maior esforço dos quatro, mas é o
   item com tese mais forte da literatura acadêmica (item 1.5) e o que mais
   estruturalmente separa o GiroCerto de "só mais um algoritmo que desativa sem
   explicar" — vale planejar mesmo que não entre nesta rodada.

Deliberadamente fora do top 4: 6.4 (posicionamento de marca) — não porque seja fraco,
mas porque é decisão de comunicação/liderança, não item de backlog técnico; e 6.5
(pacote de SOS) — porque é manutenção correta, não diferencial por si.
