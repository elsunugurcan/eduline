# Eduline — Nöbet ve olay müdahale kılavuzu

Uyarılar `data/monitor/alerts.log` dosyasına yazılır. `ALERT_WEBHOOK` tanımlıysa (Slack/Teams uyumlu `{ "text": ... }`) oraya da gönderilir. Durum sayfası: `npm run monitor` → http://localhost:8400.

## Önem seviyeleri

| Seviye | Tepki süresi | Kim |
|---|---|---|
| **Kritik** (kesinti) | 5 dk içinde müdahale, 15 dk'da durum sayfası güncellemesi | Nöbetçi + teknik sorumlu |
| **Uyarı** (yavaşlama) | Mesai içinde 1 saat, sınav saatinde 10 dk | Nöbetçi |

## Uyarı → ilk adımlar

### API erişilemiyor / Veritabanı hazır değil (kritik)
1. `curl -s localhost:8302/health` ve `/ready` komutlarını çalıştır. Ana süreç ayakta mı diye `cat data/v2.pid` ile bak, `ps -p <pid>` ile kontrol et.
2. Ana süreç ayakta ama işçiler çöküyorsa: ana süreç işçiyi otomatik yeniden başlatır. Günlükte `beklenmedik şekilde çıktı` satırını ara ve son hatayı `data/*.log` içindeki `"level":"error"` kayıtlarından oku.
3. Veritabanı bozulma şüphesi varsa (`database disk image is malformed`): trafiği durdur, **son doğrulanmış yedekten** dön (aşağıda). Tatbikatta ölçülen dönüş süresi ~0,5 sn.
4. Durum sayfasına ilk bildirimi 15 dk içinde yaz. Belirsizse "inceleniyor" demek yeterli.

### İstekler kuyrukta bekliyor (olay döngüsü gecikmesi > 500 ms, kritik)
Sunucu içi süreler normal görünürken kullanıcılar zaman aşımı yaşıyor demektir. Senkron bir iş olay döngüsünü kilitliyor.
1. `/metrics` içinde hangi rotanın `sum/count` ortalaması yükseldi? Çoğunlukla `submit` olur.
2. Son dağıtımda yeni bir sorgu var mı? `EXPLAIN QUERY PLAN` ile `SCAN` (tam tarama) arayan sorguları bul. Eksik indeks varsa `app/v2.mjs → migrateV2` içine ekle.
3. Geçici önlem olarak işçi sayısını artır (`--workers`) ve ardından kesintisiz dağıtım yap.

### Yanıt süresi yüksek (p95 > 1 sn uyarı / > 3 sn kritik)
1. Trafik grafiğine bak: yük beklenenden fazla mı? Kapasite planı `reports/capacity.json` dosyasında (SLO içinde ~4.700 istek/sn).
2. Yük normalse son dağıtımı geri al: bir önceki sürümle `npm run deploy` çalıştır.

### Hata oranı > %2 (kritik)
`data/*.log` içinde `"code":5..` satırlarını rotaya göre say. Tek rotaysa, o özelliği kapatmak için geçici bir bayrak düşün.

### Sentetik öğrenci yolculuğu yavaş (uyarı)
Ders listesi + sınav açma işlemi 2 sn'yi aşıyor. Önce yukarıdaki gecikme kurallarına bak. Onlar sessizse ağ ya da DNS katmanını kontrol et.

## Rutin işlemler

| İş | Komut | Sıklık |
|---|---|---|
| Kesintisiz dağıtım | `npm run deploy` (SIGHUP → işçiler tek tek yenilenir) | Her sürüm, **sınav saatleri dışında** |
| Yedek + geri yükleme tatbikatı | `npm run drill` | Haftalık; sonuç rapora girer |
| Bağımlılık güvenlik denetimi | `npm run audit` | Haftalık; yüksek/kritik varsa 48 saatte yama |
| Kapasite ölçümü | `npm run capacity` | Her büyük değişiklikten sonra ve dönem başında |
| Sınav saati provası | `npm run peak` | Sınav haftasından önce |
| Aylık sağlık raporu | `npm run report` | Ay sonu, müşteriye gönderilir |

## Bakım penceresi
Salı ve Perşembe 02:00–04:00. Sınav takvimindeki günlerde dağıtım yapılmaz; yalnızca kritik güvenlik yaması uygulanır ve o da kesintisiz dağıtımla yapılır.

## Olay sonrası
Her kritik olay için 48 saat içinde suçlama içermeyen bir değerlendirme yazılır: zaman çizelgesi (`alerts.log`), etki (hata ve etkilenen istek sayısı), kök neden, kalıcı düzeltme ve bu kılavuza eklenecek adım.
