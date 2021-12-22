import { Request, Response } from 'express';
import { pick } from 'lodash';

import expenseStatus from '../constants/expense_status';
import {
  createTransferWiseTransactionsAndUpdateExpense,
  getExpenseFeesInHostCurrency,
} from '../graphql/common/expenses';
import { idDecode, IDENTIFIER_TYPES } from '../graphql/v2/identifiers';
import errors from '../lib/errors';
import logger from '../lib/logger';
import models, { Op } from '../models';
import transferwise from '../paymentProviders/transferwise';

const processPaidExpense = (host, remoteUser, fundData) => async expense => {
  await expense.reload();
  if (expense.data?.transfer) {
    const payoutMethod = await expense.getPayoutMethod();
    const { feesInHostCurrency } = await getExpenseFeesInHostCurrency({
      host,
      expense,
      payoutMethod,
      fees: {},
      forceManual: false,
    });
    return createTransferWiseTransactionsAndUpdateExpense({
      host,
      expense,
      data: { ...pick(expense.data, ['transfer']), fundData },
      fees: feesInHostCurrency,
      remoteUser,
    });
  }
};

export async function payBatch(
  req: Request<any, any, { expenseIds: Array<string>; hostId: string }>,
  res: Response,
): Promise<void> {
  try {
    const { remoteUser, headers, body } = req;
    if (!remoteUser) {
      throw new errors.Unauthorized('User needs to be logged in');
    }

    const host = await models.Collective.findByPk(idDecode(body.hostId, IDENTIFIER_TYPES.ACCOUNT));
    if (!host) {
      throw new errors.NotFound('Could not find host collective');
    }
    if (!remoteUser.isAdmin(host.id)) {
      throw new errors.Unauthorized('User must be admin of host collective');
    }
    const expenseIds = body?.expenseIds?.map(id => idDecode(id, IDENTIFIER_TYPES.EXPENSE));
    const expenses = await models.Expense.findAll({
      where: { id: { [Op.in]: expenseIds } },
      include: [
        { model: models.PayoutMethod, as: 'PayoutMethod', required: true },
        {
          model: models.Collective,
          as: 'collective',
          attributes: [],
          // TODO: We should ideally use the host attached to the expense. See https://github.com/opencollective/opencollective/issues/4271
          where: { HostCollectiveId: host.id },
          required: true,
        },
      ],
    });

    expenses.forEach(expense => {
      if (expense.status !== expenseStatus.SCHEDULED_FOR_PAYMENT) {
        throw new Error(`Expense ${expense.id} must be scheduled for payment`);
      }
    });

    if (expenseIds.length !== expenses.length) {
      logger.error(
        `Wise Batch Pay: Could not find all requested expenses. ${JSON.stringify({
          requested: expenseIds,
          found: expenses.map(e => e.id),
        })}`,
      );
      throw new errors.NotFound('Could not find requested expenses');
    }
    const ottHeader = headers['x-2fa-approval'] as string;

    // Second attempt generated by Wise frontend library with 2FA hash
    if (ottHeader) {
      const fundResponse = await transferwise.payExpensesBatchGroup(host, undefined, ottHeader);
      res.sendStatus(200);
      await Promise.all(expenses.map(processPaidExpense(host, remoteUser, fundResponse)));
    }
    // First attempt without 2FA
    else {
      const fundResponse = await transferwise.payExpensesBatchGroup(host, expenses);
      // If OTT response, proxy it to the frontend and return early
      if ('status' in fundResponse && 'headers' in fundResponse) {
        res.setHeader('x-2fa-approval', fundResponse.headers['x-2fa-approval']);
        res.sendStatus(fundResponse.status);
      } else {
        // Send 200 to the frontend
        res.sendStatus(200);
        // Mark expenses as paid and create transactions
        await Promise.all(expenses.map(processPaidExpense(host, remoteUser, fundResponse)));
      }
    }
  } catch (e) {
    logger.error('Error paying Wise batch group', e);
    res
      .status(e.code || 500)
      .send(e.toString())
      .end();
  }
}
