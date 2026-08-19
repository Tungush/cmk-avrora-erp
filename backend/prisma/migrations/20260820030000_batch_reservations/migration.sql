-- 09_COSTING_AND_STAGES.md, шаг 5: резервы партий и перехват через директора.

CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'RELEASED', 'OVERRIDDEN', 'EXPIRED');
CREATE TYPE "OverrideStatus"    AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "batch_reservations" (
  "id"                UUID                NOT NULL DEFAULT gen_random_uuid(),
  "batch_id"          UUID                NOT NULL,
  "order_id"          UUID                NOT NULL,
  "order_costing_id"  UUID,
  "qty"               DECIMAL(14,3)       NOT NULL,
  "status"            "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
  -- 30 дней без движения: иначе через полгода весь металл окажется занят
  -- мёртвыми коммерческими предложениями
  "expires_at"        TIMESTAMP(3)        NOT NULL,
  "created_at"        TIMESTAMP(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by_id"     UUID,
  "released_at"       TIMESTAMP(3),
  "released_by_id"    UUID,
  "release_reason"    TEXT,
  CONSTRAINT "batch_reservations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "batch_reservations_batch_id_status_idx"  ON "batch_reservations" ("batch_id", "status");
CREATE INDEX "batch_reservations_order_id_status_idx"  ON "batch_reservations" ("order_id", "status");
CREATE INDEX "batch_reservations_status_expires_at_idx" ON "batch_reservations" ("status", "expires_at");

ALTER TABLE "batch_reservations"
  ADD CONSTRAINT "batch_reservations_batch_id_fkey"
    FOREIGN KEY ("batch_id") REFERENCES "material_batches"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  ADD CONSTRAINT "batch_reservations_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON UPDATE CASCADE ON DELETE CASCADE;

CREATE TABLE "batch_override_requests" (
  "id"                    UUID             NOT NULL DEFAULT gen_random_uuid(),
  "reservation_id"        UUID             NOT NULL,
  "requested_by_order_id" UUID             NOT NULL,
  "qty_requested"         DECIMAL(14,3)    NOT NULL,
  -- Причина обязательна: директор решает не вслепую
  "reason"                TEXT             NOT NULL,
  "status"                "OverrideStatus" NOT NULL DEFAULT 'PENDING',
  "requested_by_id"       UUID,
  "created_at"            TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_by_id"         UUID,
  "decided_at"            TIMESTAMP(3),
  "decision_comment"      TEXT,
  CONSTRAINT "batch_override_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "batch_override_requests_status_created_at_idx"
  ON "batch_override_requests" ("status", "created_at");

ALTER TABLE "batch_override_requests"
  ADD CONSTRAINT "batch_override_requests_reservation_id_fkey"
  FOREIGN KEY ("reservation_id") REFERENCES "batch_reservations"("id") ON UPDATE CASCADE ON DELETE CASCADE;
