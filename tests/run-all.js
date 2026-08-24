// Roda todas as áreas de teste em sequência (não paralelo — várias áreas criam
// tenants/entregadores/pedidos com nomes fixos e é mais fácil depurar falha real
// se não houver concorrência entre suítes disputando o mesmo banco).
// despacho_motor precisa de `npm install` em dispatch-engine/ pra funcionar
// (sobe o serviço real como subprocesso) — ver tests/README.md.
const areas = ['onboarding', 'pedido', 'despacho', 'financeiro', 'seguranca', 'reputacao', 'lgpd', 'integracoes', 'admin', 'despacho_motor'];

(async () => {
  const results = [];
  for (const area of areas) {
    console.log(`\n\n########## ÁREA: ${area} ##########`);
    const run = require(`./${area}.test.js`);
    try {
      const summary = await run();
      results.push(summary);
    } catch (e) {
      console.error(`ERRO FATAL na área ${area}:`, e);
      results.push({ area, pass: 0, fail: 1, failures: [`erro fatal: ${e.message}`] });
    }
  }

  console.log('\n\n========== RESUMO GERAL ==========');
  let totalPass = 0;
  let totalFail = 0;
  for (const r of results) {
    console.log(`${r.area}: ${r.pass} passou, ${r.fail} falhou`);
    totalPass += r.pass;
    totalFail += r.fail;
  }
  console.log(`\nTOTAL: ${totalPass} passou, ${totalFail} falhou`);
  process.exit(totalFail > 0 ? 1 : 0);
})();
