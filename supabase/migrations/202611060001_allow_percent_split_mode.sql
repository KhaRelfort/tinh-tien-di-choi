-- Migration: 202611060001_allow_percent_split_mode.sql
-- Mở rộng ràng buộc kiểm tra split_mode cho phép thêm giá trị 'percent' (chia theo %)

ALTER TABLE public.expenses DROP CONSTRAINT IF EXISTS expenses_split_mode_check;
ALTER TABLE public.expenses ADD CONSTRAINT expenses_split_mode_check CHECK (split_mode IN ('equal', 'custom', 'percent'));

