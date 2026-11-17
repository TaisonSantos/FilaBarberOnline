begin;

-- Online entry deposits are configurable. The previous constraint was fixed
-- at R$ 10, which blocked paid R$ 1 test entries from becoming queue entries.
alter table public.queue_entries
  drop constraint if exists online_entry_deposit;

alter table public.queue_entries
  add constraint online_entry_deposit
  check (entry_type <> 'online' or deposit_cents > 0);

commit;
