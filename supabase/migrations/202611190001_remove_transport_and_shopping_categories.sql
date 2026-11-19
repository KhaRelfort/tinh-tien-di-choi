-- ====================================================================
-- MIGRATION: Xóa danh mục 'Di chuyển' và 'Mua sắm' khỏi cơ sở dữ liệu
-- ====================================================================

-- 1. Nếu có khoản chi nào từng lưu 'Di chuyển' hoặc 'Mua sắm', chuyển về 'Khác' để đảm bảo an toàn toàn vẹn dữ liệu
UPDATE public.expenses
SET category = 'Khác'
WHERE category IN ('Di chuyển', 'Mua sắm');

-- 2. Thêm ràng buộc (check constraint) chỉ cho phép 4 danh mục hợp lệ:
--    'Ăn uống', 'Dịch vụ và giải trí', 'Du lịch', 'Khác'
ALTER TABLE public.expenses DROP CONSTRAINT IF EXISTS expenses_category_check;
ALTER TABLE public.expenses ADD CONSTRAINT expenses_category_check
  CHECK (category IN ('Ăn uống', 'Dịch vụ và giải trí', 'Du lịch', 'Khác'));
