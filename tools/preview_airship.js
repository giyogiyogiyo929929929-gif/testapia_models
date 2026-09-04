"use strict";
/*
 * preview_airship.js -- 従来のコマンド (node tools/preview_airship.js) を残すためのラッパー。
 * 実体は汎用の preview_model.js。出力先を変えたいときは第1引数に渡す。
 *   node tools/preview_airship.js [出力先ディレクトリ]
 */
process.argv[3] = process.argv[2];
process.argv[2] = "airship";
require("./preview_model.js");
