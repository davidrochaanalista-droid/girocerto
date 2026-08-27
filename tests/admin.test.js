// painel-admin.html — Visão Geral (sessão de 23/08/2026): tenants.habilitado
// protegido contra a própria loja, RPC definir_tenant_habilitado() admin-gated,
// e as views entregadores_presenca/tenants_operacao (security_invoker = true —
// herdam a RLS de quem chama: admin vê tudo via "dev admin ve todos ...",
// loja comum vê só o que já via antes através das próprias policies
// existentes, nunca dado de outro tenant).
const crypto = require('crypto');
const { newPgClient, createAuthUser, signInAs, makeReporter, cleanup, criarEntregador } = require('./lib/helpers');

async function run() {
  const r = makeReporter('admin');
  const pg = newPgClient();
  await pg.connect();
  const tenantIds = [];
  const authUserIds = [];

  try {
    const tenantId = crypto.randomUUID();
    await pg.query(`insert into tenants (id, nome) values ($1, 'Loja Teste Admin')`, [tenantId]);
    tenantIds.push(tenantId);
    const dono = await createAuthUser('dono.admin');
    authUserIds.push(dono.id);
    await pg.query(`insert into usuarios_loja (tenant_id, auth_user_id, nome, papel) values ($1,$2,'Dono','dono')`, [tenantId, dono.id]);
    const sessDono = await signInAs(dono.email);

    const admUser = await createAuthUser('adm.admin');
    authUserIds.push(admUser.id);
    await pg.query(`insert into desenvolvedores_admin (auth_user_id) values ($1)`, [admUser.id]);
    const sessAdmin = await signInAs(admUser.email);

    console.log('\n=== tenants.habilitado: protegido contra a própria loja, só admin via RPC ===');
    {
      const { error: eLojaDireto } = await sessDono.from('tenants').update({ habilitado: false }).eq('id', tenantId);
      r.check('loja tentando mudar habilitado via update direto é bloqueada (42501)', !!eLojaDireto && eLojaDireto.code === '42501', eLojaDireto);

      const { rows: check1 } = await pg.query(`select habilitado from tenants where id = $1`, [tenantId]);
      r.check('tentativa da loja bloqueada não alterou habilitado (continua true)', check1[0].habilitado === true, check1[0]);

      const { error: eLojaRpc } = await sessDono.rpc('definir_tenant_habilitado', { p_tenant_id: tenantId, p_habilitado: false });
      r.check('loja chamando a RPC diretamente também é bloqueada (42501)', !!eLojaRpc && eLojaRpc.code === '42501', eLojaRpc);

      const { error: eAdminRpc } = await sessAdmin.rpc('definir_tenant_habilitado', { p_tenant_id: tenantId, p_habilitado: false });
      const { rows: check2 } = await pg.query(`select habilitado from tenants where id = $1`, [tenantId]);
      r.check('admin desabilita a loja via RPC', !eAdminRpc && check2[0].habilitado === false, { eAdminRpc, check2: check2[0] });

      const { error: eAdminRpc2 } = await sessAdmin.rpc('definir_tenant_habilitado', { p_tenant_id: tenantId, p_habilitado: true });
      const { rows: check3 } = await pg.query(`select habilitado from tenants where id = $1`, [tenantId]);
      r.check('admin reabilita a loja via RPC', !eAdminRpc2 && check3[0].habilitado === true, { eAdminRpc2, check3: check3[0] });

      // outra automação sem sessão JWT (auth.uid() is null) também passa pelo trigger,
      // mesmo escape hatch de impedir_autoaprovacao_entregador() — reconfirma via pg direto
      await pg.query(`update tenants set habilitado = false where id = $1`, [tenantId]);
      const { rows: check4 } = await pg.query(`select habilitado from tenants where id = $1`, [tenantId]);
      r.check('automação de backend (sem sessão) consegue mudar habilitado (mesmo escape hatch de sempre)', check4[0].habilitado === false, check4[0]);
      await pg.query(`update tenants set habilitado = true where id = $1`, [tenantId]);
    }

    console.log('\n=== views entregadores_presenca / tenants_operacao: respeitam RLS de quem chama (security_invoker) ===');
    {
      // tenant alheio, sem nenhum vínculo com sessDono — prova isolamento de
      // verdade (loja vendo o PRÓPRIO tenant nessas views é esperado e correto,
      // já tinha policy própria pra isso antes destas views existirem; o que
      // importa é ela NÃO ver o de outro).
      const outroTenantId = crypto.randomUUID();
      await pg.query(`insert into tenants (id, nome) values ($1, 'Loja Alheia Admin')`, [outroTenantId]);
      tenantIds.push(outroTenantId);
      const outroEntUser = await createAuthUser('ent.alheio.admin');
      authUserIds.push(outroEntUser.id);
      await criarEntregador(pg, outroTenantId, outroEntUser.id, { nome: 'Entregador Alheio', tipo_veiculo: 'moto', status_verificacao: 'aprovado' });

      const { data: dLojaEnt, error: eLojaEnt } = await sessDono.from('entregadores_presenca').select('*');
      r.check(
        'loja vê só entregadores do PRÓPRIO tenant em entregadores_presenca (nenhum do tenant alheio)',
        !eLojaEnt && (dLojaEnt || []).every(e => e.tenant_id === tenantId),
        { eLojaEnt, tenantIds: (dLojaEnt || []).map(e => e.tenant_id) }
      );

      const { data: dLojaTen, error: eLojaTen } = await sessDono.from('tenants_operacao').select('*');
      r.check(
        'loja vê só o PRÓPRIO tenant em tenants_operacao (1 linha, nunca o alheio) — mesma policy "loja ve e edita seu proprio tenant" já existente, a view só herda',
        !eLojaTen && dLojaTen && dLojaTen.length === 1 && dLojaTen[0].id === tenantId,
        { eLojaTen, dLojaTen }
      );

      const { data: dAdminTen, error: eAdminTen } = await sessAdmin.from('tenants_operacao').select('*');
      const idsVistosPeloAdmin = (dAdminTen || []).map(t => t.id);
      r.check(
        'admin vê os dois tenants em tenants_operacao (o próprio da loja de teste E o alheio)',
        !eAdminTen && idsVistosPeloAdmin.includes(tenantId) && idsVistosPeloAdmin.includes(outroTenantId),
        { eAdminTen, idsVistosPeloAdmin }
      );
    }

    console.log('\n=== entregadores_presenca: online/offline derivado de localizacoes_entregador ===');
    {
      const entOnlineUser = await createAuthUser('ent.online.admin');
      authUserIds.push(entOnlineUser.id);
      const { entregadorId: entOnlineId } = await criarEntregador(pg, tenantId, entOnlineUser.id, {
        nome: 'Entregador Online', tipo_veiculo: 'moto', status_verificacao: 'aprovado', status: 'disponivel',
      });
      await pg.query(`insert into localizacoes_entregador (entregador_id, lat, lng, registrado_em) values ($1, -23.5, -46.6, now())`, [entOnlineId]);

      const entOfflineUser = await createAuthUser('ent.offline.admin');
      authUserIds.push(entOfflineUser.id);
      const { entregadorId: entOfflineId } = await criarEntregador(pg, tenantId, entOfflineUser.id, {
        nome: 'Entregador Offline', tipo_veiculo: 'moto', status_verificacao: 'aprovado', status: 'disponivel',
      });
      await pg.query(
        `insert into localizacoes_entregador (entregador_id, lat, lng, registrado_em) values ($1, -23.5, -46.6, now() - interval '10 minutes')`,
        [entOfflineId]
      );

      const entSemPosicaoUser = await createAuthUser('ent.semposicao.admin');
      authUserIds.push(entSemPosicaoUser.id);
      await criarEntregador(pg, tenantId, entSemPosicaoUser.id, {
        nome: 'Entregador Sem Posicao', tipo_veiculo: 'moto', status_verificacao: 'aprovado', status: 'pausado',
      });

      const { data: presenca, error: ePresenca } = await sessAdmin.from('entregadores_presenca').select('*').eq('tenant_id', tenantId).order('nome');
      r.check('admin lê entregadores_presenca sem erro', !ePresenca, ePresenca);
      const porNome = Object.fromEntries((presenca || []).map(e => [e.nome, e]));
      r.check('entregador com posição recente (<3min) está online', porNome['Entregador Online'] && porNome['Entregador Online'].online === true, porNome['Entregador Online']);
      r.check('entregador com posição de 10min atrás está offline', porNome['Entregador Offline'] && porNome['Entregador Offline'].online === false, porNome['Entregador Offline']);
      r.check('entregador sem nenhuma posição está offline (coalesce cobre o null)', porNome['Entregador Sem Posicao'] && porNome['Entregador Sem Posicao'].online === false, porNome['Entregador Sem Posicao']);
    }

    console.log('\n=== tenants_operacao: painel_aberto e pedidos_24h derivados corretamente ===');
    {
      await pg.query(`update tenants set painel_ativo_em = now() where id = $1`, [tenantId]);
      const { data: op1 } = await sessAdmin.from('tenants_operacao').select('*').eq('id', tenantId).single();
      r.check('painel_ativo_em recente (<90s) -> painel_aberto=true', op1 && op1.painel_aberto === true, op1);

      await pg.query(`update tenants set painel_ativo_em = now() - interval '5 minutes' where id = $1`, [tenantId]);
      const { data: op2 } = await sessAdmin.from('tenants_operacao').select('*').eq('id', tenantId).single();
      r.check('painel_ativo_em antigo (>90s) -> painel_aberto=false', op2 && op2.painel_aberto === false, op2);

      r.check('sem nenhum pedido ainda -> pedidos_24h=0', op2 && op2.pedidos_24h === 0, op2);

      await pg.query(
        `insert into pedidos (tenant_id, endereco, valor_pedido, criado_em)
         values ($1,'Rua Teste 123',30.00, now() - interval '2 hours')`,
        [tenantId]
      );
      await pg.query(
        `insert into pedidos (tenant_id, endereco, valor_pedido, criado_em)
         values ($1,'Rua Teste 456',20.00, now() - interval '2 days')`,
        [tenantId]
      );
      const { data: op3 } = await sessAdmin.from('tenants_operacao').select('*').eq('id', tenantId).single();
      r.check('1 pedido nas últimas 24h (o de 2 dias atrás não conta) -> pedidos_24h=1', op3 && op3.pedidos_24h === 1, op3);
      r.check('ultimo_pedido_em reflete o pedido mais recente (2h atrás, não o de 2 dias)', op3 && new Date(op3.ultimo_pedido_em) > new Date(Date.now() - 3 * 3600 * 1000), op3);
    }

    return r.summary();
  } finally {
    await cleanup(pg, tenantIds, authUserIds);
    await pg.end();
  }
}

if (require.main === module) {
  run().then((s) => process.exit(s.fail > 0 ? 1 : 0)).catch((e) => { console.error('ERRO FATAL:', e); process.exit(1); });
}
module.exports = run;
