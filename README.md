# CoverMeUp WA Automation (v5.7.2)

- Public dashboard at `/dashboard` (read-only)
- Health check at `/health`
- Shopify webhooks:
  - `/webhooks/shopify/orders-create`
  - `/webhooks/shopify/fulfillments-create`
- WhatsApp webhooks:
  - GET `/webhooks/whatsapp` (verification)
  - POST `/webhooks/whatsapp` (inbound messages)

## Env
```
PORT=3000
DATA_PATH=./data/db.json
WA_GRAPH_VERSION=v20.0
WA_PHONE_ID=YOUR_PHONE_NUMBER_ID
WA_TOKEN=PERMANENT_TOKEN
WA_TEMPLATE_LANG=en_US
ORDER_CONFIRMATION_TEMPLATE=order_confirmation
ORDER_SHIPPED_TEMPLATE=order_update
FALLBACK_TEMPLATE=hello_world
SHOPIFY_WEBHOOK_SECRET=... (from Shopify)
WHATSAPP_VERIFY_TOKEN=... (set by you)
BRAND_NAME=CoverMeUp
DEFAULT_COUNTRY_CODE=91
```
