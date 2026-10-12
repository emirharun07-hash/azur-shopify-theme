-- Kampagnen Board: einmalige Einrichtung der eigenen Cloud (Supabase → SQL Editor → Run)

-- Boards, Elemente und Verbindungen
create table if not exists public.kb_docs (
  path text primary key,
  parent text not null,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists kb_docs_parent on public.kb_docs (parent);
alter table public.kb_docs replica identity full;

alter table public.kb_docs enable row level security;
drop policy if exists "kb_docs team" on public.kb_docs;
create policy "kb_docs team" on public.kb_docs for all to anon, authenticated using (true) with check (true);

-- Live-Änderungen einschalten
do $$ begin
  alter publication supabase_realtime add table public.kb_docs;
exception when duplicate_object then null; end $$;

-- Speicher für Bilder, Videos und PDFs (bis 50 MB pro Datei)
insert into storage.buckets (id, name, public, file_size_limit)
values ('kb-media', 'kb-media', true, 52428800)
on conflict (id) do update set public = true, file_size_limit = 52428800;

drop policy if exists "kb-media lesen" on storage.objects;
drop policy if exists "kb-media hochladen" on storage.objects;
drop policy if exists "kb-media löschen" on storage.objects;
create policy "kb-media lesen" on storage.objects for select to anon, authenticated using (bucket_id = 'kb-media');
create policy "kb-media hochladen" on storage.objects for insert to anon, authenticated with check (bucket_id = 'kb-media');
create policy "kb-media löschen" on storage.objects for delete to anon, authenticated using (bucket_id = 'kb-media');
