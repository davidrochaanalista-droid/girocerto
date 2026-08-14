# Testes de integração — GiroCerto

Testes reais contra o Supabase hospedado do projeto (`ntmxkwzhumiqspxijuln`), não mocks —
convenção estabelecida em `CLAUDE.md`. Cada arquivo cria seus próprios dados (tenants,
usuários auth, entregadores, pedidos) via prefixo `@teste.girocerto.dev` / nomes com
"Teste", e apaga tudo no `finally` (cascade a partir de `tenants` + `admin.auth.admin.deleteUser`).

## Como rodar

Precisa do `.env` na raiz do projeto (mesmo nível de `db/`, `mockups/`) com
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` —
credenciais do projeto Supabase hospedado real. Nunca commitado (gitignored).

```bash
cd tests
npm install
node run-all.js        # roda as 8 áreas em sequência
node onboarding.test.js  # roda só uma área
```

## Estrutura

- `lib/helpers.js` — conexão (pg + supabase-js), criação de usuário autenticado,
  sign-in, reporter de asserts, cleanup. Nunca hardcoda credenciais — sempre lê de
  `.env` em runtime.
- `onboarding.test.js`, `pedido.test.js`, `despacho.test.js`, `financeiro.test.js`,
  `seguranca.test.js`, `reputacao.test.js`, `lgpd.test.js`, `integracoes.test.js` —
  uma área do checklist de operações por arquivo, cada um exporta `run()` e também
  roda standalone via `node <arquivo>.test.js`.
- `run-all.js` — roda as 8 áreas em sequência (não paralelo, pra evitar concorrência
  entre suítes disputando o mesmo banco) e imprime um resumo geral.

Ver `COBERTURA.md` pra saber o que está coberto aqui, o que já tinha sido testado em
sessões anteriores (fora deste diretório, scripts não versionados), e o que ficou como
pendência documentada por depender de feature que ainda não existe (motor de despacho,
OSRM, repasse automatizado via Pix).
