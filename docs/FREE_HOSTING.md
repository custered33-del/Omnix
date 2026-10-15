# Run Omnix free, 24/7

Omnix runs on a free Hugging Face Space, and keeps its data in a free Supabase project. Neither needs a card.

1. **Supabase** (https://supabase.com): create a free project.
   - **Connect → Session pooler**: copy the connection string, with your database password filled in.
   - **Storage**: create a bucket named `omnix`.
   - **Storage → S3**: create an access key. Note the endpoint, the region, the key id and the secret.
2. **GitHub**: make the Omnix repository public (Settings → Danger Zone → Change visibility), so the Space can download it.
3. **Hugging Face** (https://huggingface.co/new-space): create a Space named `omnix`. Choose **Docker** and **Blank**, and make it **Public**.
   - **Files → Add file → Create new file**: name it `Dockerfile` and paste in [`deploy/huggingface/Dockerfile`](../deploy/huggingface/Dockerfile).
   - **Settings → Variables and secrets**: add these secrets:

     | Secret | Value |
     | --- | --- |
     | `OMNIX_DATABASE_URL` | the Supabase connection string |
     | `OMNIX_S3_BUCKET` | `omnix` |
     | `OMNIX_S3_ENDPOINT` | the Supabase S3 endpoint |
     | `OMNIX_S3_REGION` | the Supabase S3 region |
     | `OMNIX_S3_ACCESS_KEY_ID` | the key id |
     | `OMNIX_S3_SECRET_ACCESS_KEY` | the secret |
4. Wait for the Space to say **Running** (about 10 minutes). Omnix is at `https://<your-hf-name>-omnix.hf.space`. Open it and create your account.
5. **Claude**: go to https://claude.ai/settings/connectors → **Add custom connector**. Name it `Omnix`, and use the URL `https://<your-hf-name>-omnix.hf.space/mcp`. Click **Connect**, then **Allow**. It now works in Claude chat, on your phone and in Claude Desktop.

A free Space goes to sleep after 48 hours with no visits. Opening the address wakes it in about a minute, and your data is kept in Supabase.
