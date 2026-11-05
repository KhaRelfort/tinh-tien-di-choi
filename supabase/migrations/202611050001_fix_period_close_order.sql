-- Migration: 202611050001_fix_period_close_order.sql
-- Sửa thứ tự xử lý khi chốt kỳ trong apply_sync_operation:
-- Cập nhật kỳ cũ thành 'settled' hoặc 'pending' trước khi INSERT kỳ mới 'open',
-- tránh vi phạm ràng buộc duy nhất settlement_period_one_open_per_group.

create or replace function public.apply_sync_operation(p_op_id uuid, p_operation jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_group_id uuid; v_kind text; v_record jsonb; v_expense_id uuid; v_expected timestamptz; v_current timestamptz;
  v_amount bigint; v_sum bigint; v_member_id uuid; v_period_id uuid; v_end_date date; v_next_period jsonb;
  v_unbalanced bigint;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select id into v_group_id from public.expense_groups where owner_user_id = auth.uid();
  if v_group_id is null then raise exception 'Ledger not found'; end if;
  insert into public.sync_operations(owner_user_id, op_id) values(auth.uid(), p_op_id) on conflict do nothing;
  if not found then return; end if;
  v_kind := p_operation->>'kind';

  if v_kind in ('expense_upsert', 'expense_delete') then
    v_record := coalesce(p_operation->'record', '{}'::jsonb);
    v_expense_id := coalesce((v_record->>'id')::uuid, (p_operation->>'recordId')::uuid);
    v_expected := nullif(p_operation->>'expectedUpdatedAt', 'null')::timestamptz;
    select updated_at, period_id into v_current, v_period_id from public.expenses where id = v_expense_id and group_id = v_group_id;
    if v_current is null and exists(select 1 from public.expenses where id = v_expense_id) then raise exception 'Expense does not belong to this ledger'; end if;
    if v_current is distinct from v_expected then raise exception 'Conflict: expense changed since last sync'; end if;
    if v_current is not null and exists(select 1 from public.settlement_periods where id = v_period_id and status <> 'open') then raise exception 'Expense belongs to a closed settlement period'; end if;
    if v_kind = 'expense_delete' then delete from public.expenses where id = v_expense_id and group_id = v_group_id; return; end if;
    v_amount := (v_record->>'amount')::bigint;
    select coalesce(sum((s->>'amount')::bigint), 0) into v_sum from jsonb_array_elements(v_record->'splits') s;
    if v_sum <> v_amount or jsonb_array_length(v_record->'splits') = 0 then raise exception 'Split amounts must equal the expense total'; end if;
    if not exists(select 1 from public.group_members where id = (v_record->>'payerId')::uuid and group_id = v_group_id) then raise exception 'Payer does not belong to this ledger'; end if;
    for v_member_id in select (s->>'memberId')::uuid from jsonb_array_elements(v_record->'splits') s loop
      if not exists(select 1 from public.group_members where id = v_member_id and group_id = v_group_id) then raise exception 'Split member does not belong to this ledger'; end if;
    end loop;
    if v_current is null then
      v_period_id := nullif(v_record->>'periodId', '')::uuid;
      if v_period_id is null then select id into v_period_id from public.settlement_periods where group_id = v_group_id and status = 'open'; end if;
    end if;
    if not exists(select 1 from public.settlement_periods where id = v_period_id and group_id = v_group_id and status = 'open') then raise exception 'Expenses can only be added to the open period'; end if;
    insert into public.expenses(id, group_id, title, amount_vnd, payer_member_id, spent_on, category, note, split_mode, period_id, updated_at)
      values(v_expense_id, v_group_id, trim(v_record->>'title'), v_amount, (v_record->>'payerId')::uuid, (v_record->>'date')::date, coalesce(v_record->>'category','Khác'), coalesce(v_record->>'note',''), v_record->>'splitMode', v_period_id, (v_record->>'updatedAt')::timestamptz)
      on conflict(id) do update set title=excluded.title, amount_vnd=excluded.amount_vnd, payer_member_id=excluded.payer_member_id, spent_on=excluded.spent_on, category=excluded.category, note=excluded.note, split_mode=excluded.split_mode, period_id=excluded.period_id, updated_at=excluded.updated_at
      where public.expenses.group_id = v_group_id;
    delete from public.expense_splits where expense_id = v_expense_id;
    insert into public.expense_splits(expense_id, member_id, amount_vnd)
      select v_expense_id, (s->>'memberId')::uuid, (s->>'amount')::bigint from jsonb_array_elements(v_record->'splits') s;
  elsif v_kind in ('settlement_upsert', 'settlement_delete') then
    v_record := coalesce(p_operation->'record', '{}'::jsonb);
    v_expense_id := coalesce((v_record->>'id')::uuid, (p_operation->>'recordId')::uuid);
    if v_kind = 'settlement_delete' then delete from public.settlements where id = v_expense_id and group_id = v_group_id; return; end if;
    v_amount := (v_record->>'amount')::bigint;
    if not exists(select 1 from public.group_members where id = (v_record->>'fromMemberId')::uuid and group_id = v_group_id) then raise exception 'From member does not belong to this ledger'; end if;
    if not exists(select 1 from public.group_members where id = (v_record->>'toMemberId')::uuid and group_id = v_group_id) then raise exception 'To member does not belong to this ledger'; end if;
    v_period_id := nullif(v_record->>'periodId', '')::uuid;
    if v_period_id is null then select id into v_period_id from public.settlement_periods where group_id = v_group_id and status = 'open'; end if;
    insert into public.settlements(id, group_id, from_member_id, to_member_id, amount_vnd, paid_on, note, period_id, updated_at)
      values(v_expense_id, v_group_id, (v_record->>'fromMemberId')::uuid, (v_record->>'toMemberId')::uuid, v_amount, (v_record->>'date')::date, coalesce(v_record->>'note',''), v_period_id, (v_record->>'updatedAt')::timestamptz)
      on conflict(id) do update set from_member_id=excluded.from_member_id, to_member_id=excluded.to_member_id, amount_vnd=excluded.amount_vnd, paid_on=excluded.paid_on, note=excluded.note, period_id=excluded.period_id, updated_at=excluded.updated_at
      where public.settlements.group_id = v_group_id;
  elsif v_kind = 'period_close' then
    v_period_id := (p_operation->>'periodId')::uuid;
    v_end_date := (p_operation->>'endDate')::date;
    v_next_period := p_operation->'nextPeriod';
    if not exists(select 1 from public.settlement_periods where id = v_period_id and group_id = v_group_id and status = 'open') then raise exception 'Period cannot be closed'; end if;

    -- 1. Tính toán dư nợ chưa cân bằng
    select coalesce(sum(abs(balance)), 0) into v_unbalanced from (
      select m.id,
        coalesce((select sum(e.amount_vnd) from public.expenses e where e.period_id = v_period_id and e.payer_member_id = m.id),0)
        - coalesce((select sum(s.amount_vnd) from public.expense_splits s join public.expenses e on e.id=s.expense_id where e.period_id=v_period_id and s.member_id=m.id),0)
        + coalesce((select sum(s.amount_vnd) from public.settlements s where s.period_id=v_period_id and s.from_member_id=m.id),0)
        - coalesce((select sum(s.amount_vnd) from public.settlements s where s.period_id=v_period_id and s.to_member_id=m.id),0) as balance
      from public.group_members m where m.group_id=v_group_id
    ) balances;

    -- 2. ĐÓNG KỲ CŨ TRƯỚC: chuyển status thành 'settled' hoặc 'pending' để không còn status = 'open'
    update public.settlement_periods
    set end_date = v_end_date,
        status = case when v_unbalanced = 0 then 'settled' else 'pending' end,
        settled_at = case when v_unbalanced = 0 then v_end_date else null end
    where id = v_period_id;

    -- 3. INSERT KỲ MỚI (status = 'open') - Lúc này không còn bị trùng lặp status 'open' nữa
    insert into public.settlement_periods(id, group_id, start_date, end_date, status, settled_at)
      values ((v_next_period->>'id')::uuid, v_group_id, (v_next_period->>'startDate')::date, null, 'open', null);

    -- 4. Chuyển các khoản chi và thanh toán sau ngày chốt vào kỳ mới
    update public.expenses set period_id=(v_next_period->>'id')::uuid where period_id=v_period_id and spent_on>v_end_date;
    update public.settlements set period_id=(v_next_period->>'id')::uuid where period_id=v_period_id and paid_on>v_end_date;
  elsif v_kind = 'members_update' then
    perform public.update_ledger_members(p_operation->>'groupName', p_operation->'members', p_operation->>'ownerAvatarUrl');
  else raise exception 'Unsupported sync operation'; end if;
end $$;

revoke all on function public.apply_sync_operation(uuid, jsonb) from public, anon;
grant execute on function public.apply_sync_operation(uuid, jsonb) to authenticated;

