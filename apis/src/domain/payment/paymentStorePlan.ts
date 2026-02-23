import type { PaymentStore } from './paymentStore.js';
import {
  billingPlanSelectSql,
  firstRow,
  readPlanByCode,
  type BillingPlan,
  type Queryable
} from './paymentStoreCore.js';

export const createPlanStore = (pool: Queryable): Pick<PaymentStore, 'listActivePlans' | 'getPlanByCode' | 'getPlanByStripePriceId'> => {
  return {
    async listActivePlans() {
      const result = await pool.query<BillingPlan>(
        `
          ${billingPlanSelectSql}
          WHERE is_active = TRUE
          ORDER BY sort_order ASC, plan_code ASC
        `
      );
      return result.rows;
    },

    async getPlanByCode(planCode) {
      return readPlanByCode(pool, planCode);
    },

    async getPlanByStripePriceId(stripePriceId) {
      const result = await pool.query<BillingPlan>(
        `
          ${billingPlanSelectSql}
          WHERE stripe_price_id = $1
          LIMIT 1
        `,
        [stripePriceId]
      );
      return firstRow(result.rows);
    }
  };
};
