/**
 * The person's chosen Lavka delivery point (migration 115).
 *
 * Exports:
 * - `lavkaDeliveryPointRepository`: read and replace the one point of a person.
 * - `lavkaDeliveryPointSchema`: what a stored point must look like.
 */
import { z } from "zod";

import { database } from "../database.js";
import type { LavkaDeliveryPoint } from "./lavka-client.js";

const text = (max: number) => z.string().max(max).default("");

export const lavkaDeliveryPointSchema = z.object({
  city: text(100), comment: text(300), country: text(100), doorcode: text(40), entrance: text(40), flat: text(40), floor: text(40),
  house: text(40), label: z.string().min(1).max(300), lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), placeId: text(300), street: text(200),
});

export interface LavkaDeliveryPointRepository {
  find(userId: string): Promise<LavkaDeliveryPoint | null>;
  replace(input: { familyId: string; point: LavkaDeliveryPoint; userId: string }): Promise<void>;
}

export const lavkaDeliveryPointRepository: LavkaDeliveryPointRepository = {
  async find(userId) {
    const result = await database().query<{ point: unknown }>("SELECT point FROM lavka_delivery_points WHERE user_id = $1", [userId]);
    const row = result.rows[0];
    if (!row) return null;
    const parsed = lavkaDeliveryPointSchema.safeParse(row.point);
    return parsed.success ? parsed.data : null;
  },
  async replace(input) {
    await database().query(
      `INSERT INTO lavka_delivery_points (user_id, family_id, point, updated_at) VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (user_id) DO UPDATE SET family_id = EXCLUDED.family_id, point = EXCLUDED.point, updated_at = now()`,
      [input.userId, input.familyId, JSON.stringify(lavkaDeliveryPointSchema.parse(input.point))],
    );
  },
};
