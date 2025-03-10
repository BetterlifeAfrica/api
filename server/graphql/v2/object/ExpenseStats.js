import { GraphQLInt, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { Amount } from './Amount';

export const ExpenseStats = new GraphQLObjectType({
  name: 'ExpenseStats',
  description: 'Expense statistics related to the given accounts',
  fields: () => ({
    expensesCount: { type: new GraphQLNonNull(GraphQLInt), description: 'The total number of expenses' },
    dailyAverageAmount: { type: new GraphQLNonNull(Amount), description: 'The daily average paid in expenses' },
    invoicesCount: { type: new GraphQLNonNull(GraphQLInt), description: 'Number of invoices' },
    reimbursementsCount: { type: new GraphQLNonNull(GraphQLInt), description: 'Number of reimbursements' },
    grantsCount: { type: new GraphQLNonNull(GraphQLInt), description: 'Number of grants' },
  }),
});
