name: Deploy static dashboard

on:
  workflow_dispatch:
  push:
    branches:
      - main
    paths:
      - "outputs/**"
      - ".github/workflows/update-gdebenz.yml"

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - name: Checkout
        uses: actions/checkout@v5

      - name: Configure Pages
        uses: actions/configure-pages@v5

      - name: Upload dashboard
        uses: actions/upload-pages-artifact@v3
        with:
          path: outputs

      - name: Deploy dashboard
        id: deployment
        uses: actions/deploy-pages@v4
