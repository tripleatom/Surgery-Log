# Animal Surgery Log

A shareable surgery log for stereotaxic work. It's a static site, so GitHub Pages can host it. A free Supabase project holds the database and the photos.

- **Anyone with the link** can browse records, search them, view the dorsal coordinate map, and export CSV. Viewing can be limited to the lab; see "Privacy" below.
- **Editors** sign in with an email magic link and can add or edit records and upload photos.
- Every edit and delete is saved to an audit table (`surgery_history`).

With `supabaseUrl` left empty, the site runs in **demo mode**. It loads sample data and keeps it in your browser only, so you can try it before setting anything up.

## Setup (~15 min)

1. **Create a Supabase project** (free) at https://supabase.com.
2. **Run the schema:** in the dashboard, open *SQL Editor*, paste in `supabase/schema.sql` and run it.
3. **Add editors** (yourself plus collaborators):
   ```sql
   insert into public.editors (email) values ('you@university.edu'), ('labmate@university.edu');
   ```
4. **Allow sign-in redirects:** open *Authentication → URL Configuration*. Set *Site URL* to your Pages URL (for example `https://<username>.github.io/surgery-log/`) and add the same URL under *Redirect URLs*.
5. **Fill in `config.js`:** copy the *Project URL* and the *anon public* key from *Project Settings → API*.
   The anon key is meant to be public. The row-level security policies in the schema decide who can read and write.
6. **Publish:** push this folder to a GitHub repo, then go to *Settings → Pages → Deploy from branch → main / root*.

To add a collaborator later, add their email to `editors`. They sign in with that email.

## Data model

| Group | Fields |
|---|---|
| Animal | animal ID\*, strain/genotype, sex, DOB, weight at surgery, IACUC protocol # |
| Surgery | date\*, surgeon(s), type, device/probe ID, anesthesia, analgesia, duration, complications |
| Targets (one or more per surgery) | region, hemisphere, AP, ML, DV (mm), AP/ML reference (bregma/lambda), DV reference (surface/dura/skull), insertion angle, probe/virus, volume (nL), histology-verified location |
| Photos | image plus caption (resized to ≤2000 px JPEG before upload) |
| Outcome | status, post-op/outcome notes, general notes |

Conventions: AP is positive toward anterior. ML is stored as the distance from midline, and the hemisphere field gives the side. The map plots left-hemisphere targets at negative x.

## Analysis in Python

**Export CSV** writes one row per target, so it loads straight into pandas:

```python
import pandas as pd
df = pd.read_csv("surgery_log_2026-11-11.csv")
v1 = df[df.target_region == "V1"][["animal_id", "target_ap", "target_ml", "target_dv"]]
```

You can also query the database directly with `supabase-py` or with Postgres (`targets` is a `jsonb` column).

## Privacy

Photos are **private by default**. The site and its coordinate data are public, but photos only load for signed-in people on the `editors` or `photo_viewers` list. Photos are stored in a private Supabase bucket and served through signed links that expire after 1 hour, and they are never stored in the GitHub repo. Visitors who aren't signed in see "🔒 N photos" instead.

```sql
insert into public.photo_viewers (email) values ('collaborator@institute.org');  -- view photos, no editing
```

To hide the records too, swap the public read policy in `schema.sql` for the commented editor-only one.

## Files

```
index.html  style.css  app.js  config.js
supabase/schema.sql
```
