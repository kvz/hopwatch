# Real SmokePing fixtures from AP observer

Harvested from `/srv/shared/smokeping/` on `observer1-ap-southeast-1-production` on 2026-04-19, before it was migrated to the native MTR history renderer. These are authentic SmokePing outputs used as ground-truth targets for pixel-parity diffing.

## Layout

- `xml/<category>__<target>.xml.gz` — rrdtool-dumped RRDs for a focused subset of targets (portable, small; restore with `rrdtool restore`). The live AP observer had 26 RRDs in total; this subset picks 7 varied profiles.
- `images/<category>/<target>_last_<seconds>.png` — SmokePing's own rendered PNGs for all 26 targets across 4 time windows (3h/30h/10d/360d) plus mini thumbnails. Each `_last_10800.png` pairs with the corresponding `xml/<category>__<target>.xml.gz` when that RRD is present.

## Restore a single RRD

```bash
gunzip -c xml/General__Google.xml.gz | rrdtool restore - /tmp/Google.rrd
rrdtool fetch /tmp/Google.rrd AVERAGE --start -10800 --end now
```

## Varied profiles captured

- `AWS__AP-Southeast-1` — local same-region, ~1.7ms, thick bands.
- `AWS__US-East-1` — transpacific, ~263ms, extremely stable (no visible bands).
- `AWS__EU-West-1` — transcontinental, ~197ms, real packet loss events + no-data gap.
- `General__Google` — DNS target, ~1.5ms with interesting RTT excursions.
- `General__Cloudflare` — DNS target, ~1.5ms stable.
- `Cloudflare__r2-EU` — Cloudflare R2 EU endpoint.
- `Hetzner__S3-fsn1` — recent-onset probe, flat ~160ms.
