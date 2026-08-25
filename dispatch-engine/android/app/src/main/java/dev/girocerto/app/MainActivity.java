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
   * (API 26+) — depois de criado uma vez com um som, o Android ignora
   * qualquer tentativa de trocar o som pelo mesmo channel_id; mudar
   * exigiria um channel_id novo.
   *
   * Arquivo: res/raw/buzina_bi_bi.mp3 (adicionado 24/08/2026). Atenção: o
   * canal só lê o som na CRIAÇÃO — se o app já rodou no celular antes do
   * arquivo existir, o canal ficou cacheado sem som (ou com o som padrão)
   * e reinstalar o .mp3 sozinho não conserta; precisa desinstalar/
   * reinstalar o app (ou apagar o canal em Ajustes > Notificações) pra
   * forçar a recriação com o som certo.
   */
  private void criarCanalBuzinaEntregador() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

    NotificationManager manager = getSystemService(NotificationManager.class);
    if (manager == null || manager.getNotificationChannel("girocerto_buzina_entregador") != null) return;

    Uri som = Uri.parse("android.resource://" + getPackageName() + "/raw/buzina_bi_bi");
    AudioAttributes atributos = new AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_NOTIFICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build();

    NotificationChannel canal = new NotificationChannel(
        "girocerto_buzina_entregador",
        "Novas entregas",
        NotificationManager.IMPORTANCE_HIGH
    );
    canal.setDescription("Aviso sonoro de nova entrega disponível — só buzina, sem voz.");
    canal.setSound(som, atributos);
    manager.createNotificationChannel(canal);
  }
}
