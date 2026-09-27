# Jev playground

TypeSafe AI の System One モデル **Jev** を Node.js から呼び、URL またはローカル HTML を
セマンティック構造に抽出して評価する playground です。

## Setup

Node.js 20 以降を用意して、依存関係をインストールします。

```sh
npm install
```

[TypeSafe Console](https://console.typesafe.ai/) で API キーを発行し、シェルに設定します。

```sh
export TYPESAFE_API_KEY="your-api-key"
```

`.env.example` は設定名の見本です。実際の `.env` は Git 管理されません。

## HTML を解析・評価する

```sh
npm start -- --url https://example.com
```

ローカルの HTML ファイルも入力できます。

```sh
npm start -- --file ./fixtures/page.html
```

デフォルトでは読みやすいサマリーを表示します。Jev に送られる前の抽出結果だけを確認するには、`--extract-only` を付けます。

```sh
npm start -- --file ./fixtures/page.html --extract-only
```

自動テストや他ツールで消費する完全な JSON が必要な場合は、`--json` を加えます。

```sh
npm start -- --file ./fixtures/page.html --json
```

Cheerio が HTML から文書メタデータ、見出し、ランドマーク、`main` / `article` / `section` の本文、リンク、ボタン、フォーム数を決定論的に抽出します。Jev は抽出済み JSON から、ページ種別、主コンテンツ、主要 CTA、操作が必要なページかどうか、構造の明瞭さを評価します。

主コンテンツと CTA は抽出済みの section / link からのみ選ばれます。URL の HTML は TypeSafe API に送信されるため、認証済み URL、社内 URL、個人情報や秘密情報を含む HTML は入力しないでください。JS 実行後の DOM を解析する場合は、先に Playwright 等で HTML を取得して `--file` に渡してください。

## セマンティック回帰テスト

[`semantic-pages.json`](./semantic-pages.json) にテスト対象と期待値を宣言すると、HTML 構造と Jev の意味的評価を CI で確認できます。

```sh
npm run semantic:check
```

判定結果は `PASS`、`REVIEW`、`FAIL` で表示されます。期待値と異なっても confidence が既定の 60% 未満なら `REVIEW` に留め、高 confidence の不一致だけを `FAIL` にします。`--strict` を指定すると REVIEW も失敗として扱えます。

```sh
node src/semantic-regression.js --strict
```

API キーなしで DOM の決定論的な検査（例: `main` ランドマークの有無）だけを実行する場合は、次を使います。

```sh
npm run semantic:check:offline
```

`semantic-pages.json` の `file` は manifest からの相対パスです。CI では `TYPESAFE_API_KEY` をシークレットとして設定してください。

GitHub Actions 用の [semantic-regression.yml](./.github/workflows/semantic-regression.yml) も含まれています。すべての PR でオフライン構造検査を実行し、リポジトリの `TYPESAFE_API_KEY` secret が設定されている場合だけ Jev による意味的評価も実行します。

## Verify syntax

```sh
npm run check
```
