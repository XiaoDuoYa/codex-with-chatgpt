# VERSIONING.md

## 正

`package.json` の `version` がこのプロジェクトのバージョンの正です。
`src/version.ts` は実行時に `package.json` の値を参照する派生実装です。

## 形式

Semantic Versioning の `MAJOR.MINOR.PATCH`（`v` は表示時だけ付ける）を使います。

- **MAJOR**: 互換性を壊す変更
- **MINOR**: 後方互換の機能追加
- **PATCH**: バグ修正や小さな調整

OMP適応層の変更も、利用者向けの動作契約が変わる場合だけバージョンを更新します。
バージョン更新時は `README.md` の `**version:**` 表示も同じ値へ更新します。
