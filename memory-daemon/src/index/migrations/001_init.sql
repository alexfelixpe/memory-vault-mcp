-- Migration 001: initial schema.
-- The DDL lives in ../schema.sql and is applied whole when user_version = 0
-- (see db.ts). This file exists to pin the numbering: the next schema change
-- lands as 002_*.sql and runs only on databases with user_version < 2.
SELECT 1;
