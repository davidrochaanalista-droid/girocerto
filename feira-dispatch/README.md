# feira-dispatch (integrado ao GiroCerto)

Motor de dispatch multi-parada da feira — porta do módulo externo trazido pelo
usuário (`feira-dispatch/feira-dispatch/`, fora deste repo), integrado ao
GiroCerto em 21-22/08/2026. Ver `CLAUDE.md` (item 23) pro histórico completo
da decisão de arquitetura.

## O que mudou em relação ao módulo original

- **Schema**: aplicado em `db/schema.sql` (seção "MÓDULO FEIRA"), não como
  migrations separadas — mesma convenção do resto do projeto (schema.sql é a
  fonte de verdade única, `supabase/migrations/` é cópia byte-idêntica).
- **`estabelecimentos`/`usuarios`/`produtos`** criados do zero — o módulo
  original assumia que já existiam.
- **`entregadores.latitude`/`.longitude` → `.lat`/`.lng`** em toda referência
  (nome real da coluna compartilhada, confirmado contra o banco hospedado).
- **`entregadores.tenant_id` nullable + novo `aceita_feira`** — a mesma conta
  de entregador atende restaurante (`tenant_id` preenchido) e feira
  (`aceita_feira=true`) ao mesmo tempo; `tipo_perfil` na rota diferencia o
  contexto, não a conta.
- **RLS escrita do zero** pras ~24 tabelas novas (o módulo original não
  trazia nenhuma).
- **2 bugs reais do módulo original corrigidos**: `buscarBikesOciosas()` em
  `routeManager.js` filtrava `entrega_rota.tipo_veiculo` (coluna que não
  existe nessa tabela — só `entregadores.tipo_veiculo`); `notifications.js`
  selecionava uma coluna `whatsapp` que não existe em nenhuma tabela
  (`estabelecimentos`/`usuarios` ganharam `telefone`).
- **Tratamento Sr./Sra. removido das mensagens** (correção pedida
  22/08/2026): texto final é só buzina + primeiro nome, sem honorífico
  ("Olá, [Nome]!" / "[Nome], seu pedido está chegando!..."). `usuarios.genero`
  não chegou a ser usado por mais nada, removido da tabela.

## Estrutura

```
src/
  geo.js, feeCalculator.js, vehicleRules.js, arrivalBonus.js,
  stopGrouping.js, regulatoryCompliance.js, ttsGenerator.js,
  insertionEngine.js, routeOptimizer.js, fairRotation.js,
  proximityNotifier.js, checkout.js
    — lógica pura, sem query direta contra `entregadores` (cópia direta
      do módulo original, sem alteração de comportamento)

  routeManager.js, notifications.js, index.js
    — tocam a tabela `entregadores` compartilhada ou montam o router
      Express; ajustados (lat/lng, bugs acima)

  __tests__/
    — testes standalone do módulo original (sem dependência de Supabase),
      todos passando contra o código portado: `npm test`
```

## Pendências (ver CLAUDE.md item 23 / "Pendências reais")

- A parte do entregador de `FeiraApp.jsx` (`PainelEntregador`,
  `ExtratoEntregador`, `TelaAvaliacao`) ainda não foi portada pra
  `app-entregador.html` — é o que falta pra esse motor ter alguma UI
  consumindo ele de verdade.
- `PainelFeirante`/`DashboardFeirante` (painel do feirante) e
  `CheckoutConsumidor` (checkout do consumidor) — fora de escopo desta
  rodada, sem tela existente pra integrar.
- Wrapper Capacitor (push nativo com som customizado, tracking em
  background) — depende do item acima.
- Nenhum cron real configurado ainda (`fecharRotasExpiradas`,
  `expirar_pedidos_pendentes`, `processarLote` de notificações) — os
  endpoints existem em `src/index.js`, mas nada dispara eles hoje.

## Rodando os testes

```bash
cd feira-dispatch
npm test
```
