package dev.girocerto.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    criarCanalBuzinaEntregador();
  }

  /**
   * Canal de notificação do entregador — som PRÓPRIO (buzina_bi_bi, sem
   * voz), diferente do canal 'girocerto_voz' do consumidor (planejamento
   * FCM, 22/08/2026). O som precisa estar vinculado ao canal na CRIAÇÃO
   * (API 26+) — depois de criado uma vez, o Android ignora qualquer
   * tentativa de mudar o som OU o AudioAttributes pelo mesmo channel_id;
   * qualquer mudança nos dois exige um channel_id novo (por isso o "_v2"
   * abaixo, 25/08/2026 — testado no emulador tocando baixo demais com
   * USAGE_NOTIFICATION, trocado pra USAGE_ALARM).
   *
   * USAGE_ALARM em vez de USAGE_NOTIFICATION: o som passa a tocar no
   * volume de ALARME do aparelho, não no de notificação — mais alto por
   * padrão e o usuário raramente deixa esse baixo (ao contrário do de
   * notificação), além de ter mais chance de furar o modo silencioso/Não
   * Perturbe. É o mesmo padrão que apps de entrega (Uber, iFood, Rappi)
   * usam pro aviso de "corrida nova" — o objetivo aqui é o mesmo: o
   * entregador não pode deixar de perceber, mesmo com o celular no
   * bolso ou a tela bloqueada.
   *
   * Arquivo: res/raw/buzina_bi_bi.mp3 (adicionado 24/08/2026). Atenção: o
   * canal só lê o som na CRIAÇÃO — se o app já rodou no celular antes do
   * arquivo existir (ou antes dessa mudança), o canal ficou cacheado sem
   * som/com AudioAttributes antigo, e reinstalar o app sozinho não
   * conserta isso: o Android mantém canais de channel_id antigos que já
   * existiram. Precisa desinstalar/reinstalar o app (ou apagar o canal
   * antigo em Ajustes > Notificações) pra forçar a recriação — o
   * channel_id novo aqui já resolve isso pra quem nunca instalou antes.
   *
   * Áudio ajustado 25/08/2026 (testado em aparelho físico, tocando baixo
   * mesmo com volume do aparelho no máximo): arquivo original tinha pico
   * de -6.2dB e média de -17.7dB, bem abaixo do ideal — normalizado com
   * ffmpeg (loudnorm + limiter, pico final -1.2dB) e esticado em loop pra
   * 20s (padrão pedido: toque disparando por 20s, não só um "bi-bi" de
   * menos de 2s que passa despercebido). O Android só toca o arquivo
   * inteiro uma vez por notificação — os 20s já estão dentro do .mp3, não
   * é um loop feito em código. NÃO precisa de channel_id novo pra isso: o
   * canal só guarda a URI do arquivo, o conteúdo é lido de novo a cada
   * notificação, diferente do AudioAttributes (que é travado na criação).
   */
  private void criarCanalBuzinaEntregador() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

    NotificationManager manager = getSystemService(NotificationManager.class);
    if (manager == null || manager.getNotificationChannel("girocerto_buzina_entregador_v2") != null) return;

    Uri som = Uri.parse("android.resource://" + getPackageName() + "/raw/buzina_bi_bi");
    AudioAttributes atributos = new AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ALARM)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build();

    NotificationChannel canal = new NotificationChannel(
        "girocerto_buzina_entregador_v2",
        "Novas entregas",
        NotificationManager.IMPORTANCE_HIGH
    );
    canal.setDescription("Aviso sonoro de nova entrega disponível — só buzina, sem voz, no volume de alarme.");
    canal.setSound(som, atributos);
    manager.createNotificationChannel(canal);
  }
}
