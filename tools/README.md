# tools

Minecraft を起動せずにモデルを作る/確認するための Node スクリプト。
リソースパックのローダはこのフォルダを見ないので、置いてあっても実害はない。

| ファイル | 用途 |
|---|---|
| `gen_airship.js` | `models/entity/airship.geo.json` と `textures/entity/airship.png` を生成する。**飛行船の形状・塗りのソースはこのファイル**。 |
| `gen_goliath.js` | `models/entity/goliath.geo.json` と `textures/entity/goliath.png` を生成する。**空中戦艦(ゴリアテ級)の形状・塗りのソースはこのファイル**。 |
| `gen_tank.js` | `models/entity/tank.geo.json` と `textures/entity/tank.png` を生成する。**戦車の形状・塗りのソースはこのファイル**。 |
| `gen_warrior.js` | `models/entity/warrior.geo.json` と `textures/entity/warrior.png` を生成する。**戦士の形状・塗りのソースはこのファイル**。 |
| `gen_fighter.js` | `models/entity/fighter.geo.json` と `textures/entity/fighter.png` を生成する。**戦闘機の形状・塗りのソースはこのファイル**。 |
| `gen_dreadnought.js` | `models/entity/dreadnought.geo.json` と `textures/entity/dreadnought.png` を生成する。**戦艦の形状・塗りのソースはこのファイル**。 |
| `gen_anti_air.js` | `models/entity/anti_air.geo.json` と `textures/entity/anti_air.png` を生成する。**対空砲の形状・塗りのソースはこのファイル**。 |
| `gen_missile.js` | `models/entity/missile.geo.json` と `textures/entity/missile.png` を生成する。**ミサイルの形状・塗りのソースはこのファイル**。 |
| `preview_model.js` | 生成物をオフラインでレンダリングして `tools/preview/<名前>_*.png`(側面/斜め/上面/正面)に出す。形と塗りの当たり確認用。 |
| `preview_airship.js` | 上を airship 指定で呼ぶだけの薄いラッパー(従来のコマンドを残してあるだけ)。 |

```
node tools/gen_tank.js              # 戦車の geo + テクスチャを再生成
node tools/preview_model.js tank    # 戦車の確認画像を再生成
node tools/gen_airship.js
node tools/preview_model.js airship
node tools/gen_goliath.js
node tools/preview_model.js goliath
node tools/gen_warrior.js
node tools/preview_model.js warrior
node tools/gen_fighter.js
node tools/preview_model.js fighter
node tools/gen_dreadnought.js
node tools/preview_model.js dreadnought
node tools/gen_anti_air.js
node tools/preview_model.js anti_air
node tools/gen_missile.js
node tools/preview_model.js missile
```

## 触るときの注意

- テクスチャは per-face UV(面ごとに 1テクセル = 1モデル単位)でアトラスに自動配置している。
  Blockbench で形を編集すると UV が合わなくなるので、**形を変えたら生成スクリプト側を直して再生成する**こと。
- `preview_model.js` の `faceQuad()` は各ジェネレータの `faceInfo()` と対になっている。
  片方だけ直すとプレビューだけ嘘になる。
- `preview_model.js` はボーンの pivot / rotation を無視してモデル空間のまま描く。
  可動部(プロペラ・砲塔など)は静止状態でしか確認できない。
- 塗りの関数はモデル空間の座標を受け取る。面をまたいで模様を繋げたいときはこれを使う。
  ただし面の UV の向き(左右反転など)は Bedrock 側の仕様に依存するため、
  左右対称・上下方向のみに依存する模様に留めてある。
- ボーン名は他のファイルから参照していることがある。改名したら両方直すこと。
  - airship: `prop1`〜`prop4` / `rudder` / `elev_l` / `elev_r` / `flag` / `root`
    → `animations/airship.animation.json`
  - goliath: `root` / `hull` / `keel` / `bridge` / `turret_t1` / `turret_t2` / `turret_b1` /
    `turret_b2` / `prop1`〜`prop4` / `rudder` / `elev_r` / `elev_l` / `flag`
    → `animations/goliath.animation.json`。`cruise`(浮遊のうねり)・`propeller_spin`・
      `watch`(砲塔の緩い旋回)の3本を同時に流している。砲塔4基は pivot を各砲塔の中心から
      動かすと砲身が土台からずれる。`prop1`〜`prop4` は**機軸(Z)まわり**に回すので、
      pivot をプロペラ面の中心(x=±55, y=YC)から動かさないこと。
    💡 艦体は「断面を上下の帯に割った積み木」なので、帯どうしの合わせ目は flat にして
      アトラスを節約している(`gen_goliath.js` 冒頭の注記を読むこと)。飛行船 `airship`
      とは別モデルで、あちらを置き換えるものではない。
  - tank: `root` / `hull` / `turret` / `gun` / `mg`
    → 今はアニメーション未使用(砲塔旋回・砲の俯仰を付けるときの軸として切ってある)
  - fighter: `root` / `body` / `fin_r` / `fin_l` / `stab_r` / `stab_l` / `flame`
    → `animations/fighter.animation.json`。`flame`(アフターバーナー)は rotation ではなく
      **scale** で脈動させているので、ボーンの pivot をノズル出口(z=42)から動かさないこと。
  - dreadnought: `root` / `hull` / `super` / `director` / `turret_a` / `turret_b` / `turret_x` / `turret_y`
    → `animations/dreadnought.animation.json`。`root` はうねりに合わせた横揺れ・縦揺れ、
      砲塔4基と方位盤(`director`)は yaw をゆっくり振っているだけなので、pivot を
      各砲塔の中心から動かすと砲身が土台からずれる。
    💡 モデルの **y=0 が喫水線**(海軍ユニットは水面の高さに置かれる)。船体キューブの
      y0/y1 を触るときは gen_dreadnought.js 冒頭の注記も読むこと。
  - anti_air: `root` / `base` / `radar` / `mount` / `cradle`
    → `animations/anti_air.animation.json`。`mount` は yaw、`cradle` は pitch、`radar` は
      柱の上で yaw を回し続けるだけ。`cradle` には**静止状態の仰角を geo の rotation で
      与えてある**ので、アニメーションはそこへの加算になる(pivot を耳軸から動かすと
      砲身が砲架から抜ける)。
  - missile: `root` / `body` / `flame`
    → `animations/missile.animation.json`。`body` は機軸まわりのゆっくりしたロール、
      `flame`(噴炎)は rotation ではなく **scale** で脈動させているので、ボーンの pivot を
      噴口の出口(z=30)から動かさないこと。静止した在庫として飾りたいときは
      `burn` を外すか flame を scale 0 にする。
  - warrior: `root` / `body` / `head` / `crest` / `arm_r` / `arm_l` / `spear` / `shield` / `leg_r` / `leg_l`
    → `animations/warrior.animation.json`。`body` / `arm_r` / `spear` は**わざと動かしていない**
      (槍は石突きを地面に突いて立たせているので、根元を動かすと穂先が地面から浮く)。
- 旧モデル一式は `backup/airship_v1/` `backup/tank_v1/` `backup/warrior_v1/` `backup/fighter_v1/` に置いてある。
