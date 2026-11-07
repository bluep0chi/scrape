# scrape

Scraper Pornhub dan Nekopoi.

Butuh Node.js 18+

## Install

```
pkg install nodejs
atau
apt install nodejs
```

## Pornhub

```
node pornhub.js search anime
node pornhub.js search anime 1 3
node pornhub.js category teen
node pornhub.js tag "robot girl hentai"
node pornhub.js pornstar rae-lil-black
node pornhub.js model alina-rai
node pornhub.js channel <slug>
node pornhub.js video 66f382b10435a
node pornhub.js categories
node pornhub.js pornstars 1
```

opsi
```
--json hasil.json
--pages 5
--concurrency 3
```

## Nekopoi

```
node nekopoi.js list 1 20
node nekopoi.js search hanabi
node nekopoi.js category jav
node nekopoi.js genres
node nekopoi.js genre action
node nekopoi.js detail <url>
node nekopoi.js series <url>
node nekopoi.js comments <path>
node nekopoi.js all 10 out.json
```

## Catatan

Kalau error timeout atau CERT_HAS_EXPIRED berarti jaringan lu diblokir ISP, ganti jaringan atau pake VPN
