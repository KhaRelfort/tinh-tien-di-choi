-- ====================================================================
-- MIGRATION: 202611180001_guest_uuid_access.sql
-- HỖ TRỢ TRUY CẬP VÀ ĐỒNG BỘ SỔ QUA MÃ UUID (DÀNH CHO KHÁCH KHÔNG CẦN TÀI KHOẢN)
-- SCRIPT TỰ ĐỦ (SELF-CONTAINED): TỰ TẠO BẢNG NẾU DỰ ÁN MỚI HOẶC CẬP NHẬT BẢNG NẾU ĐÃ CÓ
-- ====================================================================

-- --------------------------------------------------------------------
-- 1. TẠO CÁC BẢNG NỀN TẢNG NẾU CHƯA CÓ (IDEMPOTENT DDL)
-- --------------------------------------------------------------------

create table if not exists public.expense_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_user_id uuid references auth.users(id) on delete set null,
  owner_avatar_url text,
  share_code uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.expense_groups(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  avatar_url text,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.settlement_periods (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.expense_groups(id) on delete cascade,
  start_date date not null default current_date,
  end_date date,
  status text not null default 'open' check (status in ('open', 'closed', 'settled', 'archived')),
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.expense_groups(id) on delete cascade,
  title text not null,
  amount_vnd bigint not null check (amount_vnd > 0),
  payer_member_id uuid not null references public.group_members(id) on delete restrict,
  spent_on date not null default current_date,
  note text default '',
  category text default 'Khác',
  split_mode text not null default 'equal',
  period_id uuid references public.settlement_periods(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.expense_splits (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references public.expenses(id) on delete cascade,
  member_id uuid not null references public.group_members(id) on delete restrict,
  amount_vnd bigint not null default 0 check (amount_vnd >= 0)
);

create table if not exists public.settlements (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.expense_groups(id) on delete cascade,
  from_member_id uuid references public.group_members(id) on delete restrict,
  to_member_id uuid references public.group_members(id) on delete restrict,
  payer_member_id uuid references public.group_members(id) on delete restrict,
  receiver_member_id uuid references public.group_members(id) on delete restrict,
  amount_vnd bigint not null check (amount_vnd > 0),
  paid_on date not null default current_date,
  settled_at timestamptz,
  note text default '',
  period_id uuid references public.settlement_periods(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sync_operations (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references auth.users(id) on delete set null,
  op_id uuid not null unique,
  created_at timestamptz not null default now()
);

-- --------------------------------------------------------------------
-- 2. ĐẢM BẢO CÁC CỘT VÀ CHỈ MỤC MỚI NHẤT ĐỀU ĐÃ TỒN TẠI
-- --------------------------------------------------------------------

alter table public.expense_groups add column if not exists owner_avatar_url text;
alter table public.expense_groups add column if not exists share_code uuid default gen_random_uuid();
update public.expense_groups set share_code = gen_random_uuid() where share_code is null;
create index if not exists idx_expense_groups_share_code on public.expense_groups(share_code);
alter table public.group_members add column if not exists email text;
alter table public.group_members add column if not exists avatar_url text;
alter table public.expenses add column if not exists created_at timestamptz default now();

alter table public.settlements add column if not exists from_member_id uuid references public.group_members(id) on delete restrict;
alter table public.settlements add column if not exists to_member_id uuid references public.group_members(id) on delete restrict;
alter table public.settlements add column if not exists payer_member_id uuid references public.group_members(id) on delete restrict;
alter table public.settlements add column if not exists receiver_member_id uuid references public.group_members(id) on delete restrict;
alter table public.settlements add column if not exists paid_on date default current_date;
alter table public.settlements add column if not exists settled_at timestamptz;

-- Cập nhật ràng buộc split_mode cho expenses (hỗ trợ 'equal', 'custom', 'percent')
alter table public.expenses drop constraint if exists expenses_split_mode_check;
alter table public.expenses add constraint expenses_split_mode_check check (split_mode in ('equal', 'custom', 'percent'));

-- Tạo các chỉ mục tối ưu truy vấn
create index if not exists idx_group_members_group on public.group_members(group_id);
create index if not exists idx_group_members_email on public.group_members (lower(trim(email)));
create unique index if not exists idx_group_members_group_id_id on public.group_members (group_id, id);

create index if not exists idx_expenses_group on public.expenses(group_id);
create index if not exists idx_expenses_spent_on on public.expenses(spent_on desc);
create index if not exists idx_expense_splits_expense on public.expense_splits(expense_id);
create index if not exists idx_settlement_periods_group on public.settlement_periods(group_id);
create index if not exists idx_settlements_group on public.settlements(group_id);

-- View thống kê chi tiêu hàng tháng
create or replace view public.monthly_expense_totals as
select
  to_char(spent_on, 'YYYY-MM-01') as month_start,
  coalesce(sum(amount_vnd), 0)::bigint as total_amount_vnd
from public.expenses
group by 1;

-- Bật RLS
alter table public.expense_groups enable row level security;
alter table public.group_members enable row level security;
alter table public.expenses enable row level security;
alter table public.expense_splits enable row level security;
alter table public.settlement_periods enable row level security;
alter table public.settlements enable row level security;
alter table public.sync_operations enable row level security;

-- --------------------------------------------------------------------
-- 3. HÀM TẠO SỔ MỚI: initialize_ledger
-- --------------------------------------------------------------------

create or replace function public.initialize_ledger(
  p_name text,
  p_member_names text[]
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_group_id uuid;
  v_period_id uuid;
  v_name text;
  v_index integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if array_length(p_member_names, 1) is null or array_length(p_member_names, 1) < 4 then
    raise exception 'Sổ phải có ít nhất 4 thành viên';
  end if;

  insert into public.expense_groups (name, owner_user_id, share_code)
  values (trim(p_name), auth.uid(), gen_random_uuid())
  returning id into v_group_id;

  insert into public.settlement_periods (group_id, start_date, status)
  values (v_group_id, current_date, 'open')
  returning id into v_period_id;

  foreach v_name in array p_member_names loop
    v_index := v_index + 1;
    insert into public.group_members (group_id, name, sort_order, is_active)
    values (v_group_id, trim(v_name), v_index, true);
  end loop;

  return public.get_ledger_snapshot(v_group_id);
end;
$$;

-- --------------------------------------------------------------------
-- 3b. HÀM ĐỔI MÃ UUID MỚI CHO SỔ: regenerate_ledger_share_code
-- --------------------------------------------------------------------

drop function if exists public.regenerate_ledger_share_code(uuid);
drop function if exists public.regenerate_ledger_share_code(text);

create or replace function public.regenerate_ledger_share_code(p_group_id text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_group_id uuid;
  v_new_code uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  begin
    v_group_id := p_group_id::uuid;
  exception when others then
    raise exception 'Mã sổ không hợp lệ';
  end;

  if not exists (select 1 from public.expense_groups where id = v_group_id and owner_user_id = auth.uid()) then
    raise exception 'Chỉ chủ sổ mới có quyền tạo mã mới';
  end if;

  v_new_code := gen_random_uuid();
  update public.expense_groups
  set share_code = v_new_code,
      updated_at = now()
  where id = v_group_id;

  return v_new_code::text;
end;
$$;

-- --------------------------------------------------------------------
-- 4. HÀM LẤY DANH SÁCH SỔ CHO USER ĐÃ ĐĂNG NHẬP: get_user_ledgers
-- --------------------------------------------------------------------

create or replace function public.get_user_ledgers()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user_email text;
  v_result jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  v_user_email := lower(trim(coalesce(auth.jwt()->>'email', '')));

  select jsonb_agg(jsonb_build_object(
    'id', g.id,
    'name', g.name,
    'isOwner', (g.owner_user_id = auth.uid()),
    'ownerEmail', (select email from auth.users where id = g.owner_user_id),
    'linkedMemberName', (
      select m.name from public.group_members m
      where m.group_id = g.id and lower(trim(coalesce(m.email, ''))) = v_user_email
      limit 1
    ),
    'linkedMemberId', (
      select m.id from public.group_members m
      where m.group_id = g.id and lower(trim(coalesce(m.email, ''))) = v_user_email
      limit 1
    ),
    'createdAt', g.created_at
  ) order by (g.owner_user_id = auth.uid()) desc, g.created_at desc)
  into v_result
  from public.expense_groups g
  where g.owner_user_id = auth.uid()
     or (v_user_email <> '' and exists (
          select 1 from public.group_members m
          where m.group_id = g.id and lower(trim(coalesce(m.email, ''))) = v_user_email
        ));

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

-- --------------------------------------------------------------------
-- 5. HÀM TẢI CHI TIẾT SỔ: get_ledger_snapshot (HỖ TRỢ CẢ KHÁCH DÙNG UUID)
-- --------------------------------------------------------------------

create or replace function public.get_ledger_snapshot(p_group_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_group public.expense_groups%rowtype;
  v_user_email text := '';
  v_current_member_id uuid := null;
  v_is_guest boolean := false;
  v_is_owner boolean := false;
begin
  if auth.uid() is null then
    -- Khi là khách không có tài khoản: bắt buộc phải có p_group_id
    if p_group_id is null then
      raise exception 'Mã sổ chi tiêu không được để trống';
    end if;

    select * into v_group from public.expense_groups
    where share_code = p_group_id or id = p_group_id;

    if v_group.id is null then
      return jsonb_build_object('id', null, 'error', 'Mã sổ không chính xác hoặc đã được đổi mã mới. Vui lòng xin mã mới từ chủ sổ.');
    end if;
    v_is_guest := true;
    v_is_owner := false;
  else
    v_user_email := lower(trim(coalesce(auth.jwt()->>'email', '')));

    if p_group_id is not null then
      select * into v_group from public.expense_groups g
      where g.id = p_group_id or g.share_code = p_group_id;
    else
      select * into v_group from public.expense_groups g
      where g.owner_user_id = auth.uid()
      order by g.created_at desc limit 1;

      if v_group.id is null and v_user_email <> '' then
        select g.* into v_group from public.expense_groups g
        join public.group_members m on m.group_id = g.id
        where lower(trim(coalesce(m.email, ''))) = v_user_email
        order by g.created_at desc limit 1;
      end if;
    end if;

    if v_group.id is null then
      return jsonb_build_object('id', null);
    end if;

    v_is_owner := (v_group.owner_user_id = auth.uid());

    if v_user_email <> '' then
      select id into v_current_member_id
      from public.group_members
      where group_id = v_group.id and lower(trim(coalesce(email, ''))) = v_user_email
      limit 1;
    end if;
  end if;

  return jsonb_build_object(
    'id', v_group.id,
    'name', v_group.name,
    'shareCode', coalesce(v_group.share_code, v_group.id),
    'ownerAvatarUrl', v_group.owner_avatar_url,
    'isOwner', v_is_owner,
    'isGuest', v_is_guest,
    'currentUserEmail', v_user_email,
    'currentMemberId', v_current_member_id,
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id,
        'name', m.name,
        'sortOrder', m.sort_order,
        'active', m.is_active,
        'avatarUrl', m.avatar_url,
        'email', m.email
      ) order by m.sort_order)
      from public.group_members m
      where m.group_id = v_group.id
    ), '[]'::jsonb),
    'expenses', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id,
        'title', e.title,
        'amount', e.amount_vnd,
        'payerId', e.payer_member_id,
        'date', e.spent_on,
        'note', coalesce(e.note, ''),
        'category', coalesce(e.category, 'Khác'),
        'splitMode', e.split_mode,
        'createdAt', coalesce(e.created_at, e.updated_at),
        'updatedAt', e.updated_at,
        'periodId', e.period_id,
        'splits', coalesce((
          select jsonb_agg(jsonb_build_object(
            'memberId', s.member_id,
            'amount', s.amount_vnd
          ) order by s.member_id)
          from public.expense_splits s
          where s.expense_id = e.id
        ), '[]'::jsonb)
      ) order by e.spent_on desc, e.updated_at desc)
      from public.expenses e
      where e.group_id = v_group.id
    ), '[]'::jsonb),
    'settlements', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id,
        'fromMemberId', coalesce(s.from_member_id, s.payer_member_id),
        'toMemberId', coalesce(s.to_member_id, s.receiver_member_id),
        'amount', s.amount_vnd,
        'date', coalesce(s.paid_on, (s.settled_at at time zone 'Asia/Ho_Chi_Minh')::date, current_date),
        'note', coalesce(s.note, ''),
        'periodId', s.period_id,
        'updatedAt', coalesce(s.updated_at, s.settled_at)
      ) order by coalesce(s.paid_on, (s.settled_at at time zone 'Asia/Ho_Chi_Minh')::date, current_date) desc)
      from public.settlements s
      where s.group_id = v_group.id
    ), '[]'::jsonb),
    'periods', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id,
        'startDate', p.start_date,
        'endDate', p.end_date,
        'status', p.status,
        'settledAt', coalesce(p.settled_at, p.end_date)
      ) order by p.start_date desc)
      from public.settlement_periods p
      where p.group_id = v_group.id
    ), '[]'::jsonb)
  );
end;
$$;

-- --------------------------------------------------------------------
-- 6. HÀM CẬP NHẬT THÀNH VIÊN: update_ledger_members
-- --------------------------------------------------------------------

create or replace function public.update_ledger_members(
  p_name text,
  p_members jsonb,
  p_owner_avatar_url text default null,
  p_group_id uuid default null
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_group_id uuid;
  v_member jsonb;
  v_member_id uuid;
  v_sort_order integer;
  v_name text;
  v_avatar_url text;
  v_email text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  if p_group_id is not null then
    v_group_id := p_group_id;
  else
    select id into v_group_id from public.expense_groups where owner_user_id = auth.uid() limit 1;
  end if;

  if v_group_id is null then raise exception 'Ledger not found'; end if;

  if not exists (select 1 from public.expense_groups where id = v_group_id and owner_user_id = auth.uid()) then
    raise exception 'Chỉ chủ sổ mới có quyền cập nhật thành viên và liên kết email';
  end if;

  if jsonb_typeof(p_members) <> 'array' or jsonb_array_length(p_members) < 4 then
    raise exception 'Sổ phải có ít nhất 4 thành viên';
  end if;

  update public.expense_groups
  set name = trim(p_name),
      owner_avatar_url = coalesce(p_owner_avatar_url, owner_avatar_url),
      updated_at = now()
  where id = v_group_id;

  for v_member in select value from jsonb_array_elements(p_members) loop
    v_member_id := (v_member->>'id')::uuid;
    v_sort_order := (v_member->>'sortOrder')::integer;
    v_name := trim(v_member->>'name');
    v_avatar_url := v_member->>'avatarUrl';
    v_email := lower(trim(nullif(v_member->>'email', '')));

    insert into public.group_members(id, group_id, name, sort_order, is_active, avatar_url, email)
    values (v_member_id, v_group_id, v_name, v_sort_order, coalesce((v_member->>'active')::boolean, true), v_avatar_url, v_email)
    on conflict (id) do update set
      name = excluded.name,
      sort_order = excluded.sort_order,
      is_active = excluded.is_active,
      avatar_url = excluded.avatar_url,
      email = excluded.email;
  end loop;
end;
$$;

-- --------------------------------------------------------------------
-- 7. HÀM ĐỒNG BỘ: apply_sync_operation (HỖ TRỢ CẢ KHÁCH DÙNG UUID)
-- --------------------------------------------------------------------

create or replace function public.apply_sync_operation(p_op_id uuid, p_operation jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_group_id uuid;
  v_kind text;
  v_record jsonb;
  v_expense_id uuid;
  v_user_email text := '';
  v_is_owner boolean := false;
  v_amount bigint;
  v_period_id uuid;
begin
  v_kind := p_operation->>'kind';
  v_group_id := nullif(p_operation->>'groupId', '')::uuid;

  if auth.uid() is null then
    -- Khi là khách không có tài khoản: bắt buộc phải có groupId
    if v_group_id is null then
      raise exception 'Mã sổ (groupId) không được để trống khi truy cập với vai trò khách';
    end if;

    if not exists (select 1 from public.expense_groups where id = v_group_id) then
      raise exception 'Không tìm thấy sổ chi tiêu hoặc mã sổ không hợp lệ';
    end if;
  else
    v_user_email := lower(trim(coalesce(auth.jwt()->>'email', '')));
    if v_group_id is null then
      select id into v_group_id from public.expense_groups where owner_user_id = auth.uid() limit 1;
    end if;

    if v_group_id is null then raise exception 'Ledger not found'; end if;

    select (owner_user_id = auth.uid()) into v_is_owner
    from public.expense_groups where id = v_group_id;
  end if;

  -- BẢO VỆ CHỐT SỔ: Chặn nếu không phải chủ sổ
  if v_kind = 'period_close' and v_is_owner is not true then
    raise exception 'Chỉ chủ sổ mới có quyền chốt sổ kỳ này';
  end if;

  -- BẢO VỆ THÀNH VIÊN: Chặn nếu không phải chủ sổ
  if v_kind = 'members_update' and v_is_owner is not true then
    raise exception 'Chỉ chủ sổ mới có quyền cập nhật thành viên và liên kết email';
  end if;

  -- Ghi nhận thao tác đồng bộ (idempotent)
  insert into public.sync_operations(owner_user_id, op_id)
  values (auth.uid(), p_op_id)
  on conflict (op_id) do nothing;

  -- Thực thi thao tác
  if v_kind = 'expense_upsert' then
    v_record := p_operation->'record';
    v_expense_id := (v_record->>'id')::uuid;

    insert into public.expenses(
      id, group_id, title, amount_vnd, payer_member_id, spent_on,
      category, note, split_mode, period_id, updated_at, created_at
    )
    values (
      v_expense_id, v_group_id, trim(v_record->>'title'), (v_record->>'amount')::bigint,
      (v_record->>'payerId')::uuid, (v_record->>'date')::date,
      coalesce(v_record->>'category', 'Khác'), coalesce(v_record->>'note', ''),
      coalesce(v_record->>'splitMode', 'equal'), nullif(v_record->>'periodId', '')::uuid,
      coalesce(nullif(v_record->>'updatedAt', '')::timestamptz, now()),
      coalesce(nullif(v_record->>'createdAt', '')::timestamptz, nullif(v_record->>'updatedAt', '')::timestamptz, now())
    )
    on conflict (id) do update set
      title = excluded.title,
      amount_vnd = excluded.amount_vnd,
      payer_member_id = excluded.payer_member_id,
      spent_on = excluded.spent_on,
      category = excluded.category,
      note = excluded.note,
      split_mode = excluded.split_mode,
      period_id = excluded.period_id,
      updated_at = excluded.updated_at;

    delete from public.expense_splits where expense_id = v_expense_id;
    if jsonb_typeof(v_record->'splits') = 'array' then
      insert into public.expense_splits(expense_id, member_id, amount_vnd)
      select v_expense_id, (item->>'memberId')::uuid, (item->>'amount')::bigint
      from jsonb_array_elements(v_record->'splits') as item;
    end if;

  elsif v_kind = 'expense_delete' then
    delete from public.expenses where id = (p_operation->>'recordId')::uuid and group_id = v_group_id;

  elsif v_kind = 'settlement_upsert' then
    v_record := p_operation->'record';
    v_expense_id := (v_record->>'id')::uuid;
    v_amount := (v_record->>'amount')::bigint;
    v_period_id := nullif(v_record->>'periodId', '')::uuid;
    if v_period_id is null then
      select id into v_period_id from public.settlement_periods where group_id = v_group_id and status = 'open' limit 1;
    end if;

    insert into public.settlements(
      id, group_id, from_member_id, to_member_id, amount_vnd, paid_on, note, period_id, updated_at
    )
    values (
      v_expense_id, v_group_id, (v_record->>'fromMemberId')::uuid,
      (v_record->>'toMemberId')::uuid, v_amount, (v_record->>'date')::date,
      coalesce(v_record->>'note', ''), v_period_id,
      coalesce(nullif(v_record->>'updatedAt', '')::timestamptz, now())
    )
    on conflict (id) do update set
      from_member_id = excluded.from_member_id,
      to_member_id = excluded.to_member_id,
      amount_vnd = excluded.amount_vnd,
      paid_on = excluded.paid_on,
      note = excluded.note,
      period_id = excluded.period_id,
      updated_at = excluded.updated_at;

  elsif v_kind = 'settlement_delete' then
    delete from public.settlements where id = (p_operation->>'recordId')::uuid and group_id = v_group_id;

  elsif v_kind = 'members_update' then
    perform public.update_ledger_members(
      p_operation->>'groupName',
      p_operation->'members',
      p_operation->>'ownerAvatarUrl',
      v_group_id
    );

  elsif v_kind = 'period_close' then
    update public.settlement_periods
    set end_date = (p_operation->>'endDate')::date,
        status = 'closed',
        settled_at = now()
    where id = (p_operation->>'periodId')::uuid and group_id = v_group_id;

    if p_operation->'nextPeriod' is not null then
      v_record := p_operation->'nextPeriod';
      insert into public.settlement_periods(id, group_id, start_date, end_date, status)
      values (
        (v_record->>'id')::uuid, v_group_id,
        (v_record->>'startDate')::date, null, 'open'
      )
      on conflict (id) do nothing;
    end if;
  end if;
end;
$$;

-- --------------------------------------------------------------------
-- 8. CẤP QUYỀN THỰC THI (CHO CẢ AUTHENTICATED VÀ ANON - KHÁCH DÙNG UUID)
-- --------------------------------------------------------------------

grant usage on schema public to anon, authenticated;
grant execute on function public.get_ledger_snapshot(uuid) to authenticated, anon;
grant execute on function public.apply_sync_operation(uuid, jsonb) to authenticated, anon;
grant execute on function public.get_user_ledgers() to authenticated;
grant execute on function public.initialize_ledger(text, text[]) to authenticated;
grant execute on function public.update_ledger_members(text, jsonb, text, uuid) to authenticated;
grant execute on function public.regenerate_ledger_share_code(text) to authenticated, anon;
grant select on public.monthly_expense_totals to authenticated, anon;

-- Bắt buộc PostgREST nạp lại schema cache ngay lập tức
notify pgrst, 'reload schema';
