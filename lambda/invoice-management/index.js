const AWS = require('aws-sdk');

const dynamo = new AWS.DynamoDB.DocumentClient();
const TABLE = process.env.TABLE;

exports.handler = async event => {
  console.log('Event:', JSON.stringify(event, null, 2));

  const { httpMethod, pathParameters, queryStringParameters } = event;
  const invoiceId = pathParameters?.invoiceId;

  try {
    switch (httpMethod) {
      case 'GET':
        if (invoiceId) {
          // Get specific invoice
          return await getInvoice(invoiceId);
        } else {
          // Get all invoices with optional filtering
          return await getInvoices(queryStringParameters);
        }

      case 'PUT':
        // Update invoice status (limited fields for security)
        return await updateInvoiceStatus(invoiceId, event.body);

      case 'DELETE':
        // Delete invoice (only if pending)
        return await deleteInvoice(invoiceId);

      default:
        return {
          statusCode: 405,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Method not allowed' }),
        };
    }
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message }),
    };
  }
};

async function getInvoice(invoiceId) {
  const result = await dynamo
    .get({
      TableName: TABLE,
      Key: { invoiceId },
    })
    .promise();

  if (!result.Item) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invoice not found' }),
    };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(result.Item),
  };
}

async function getInvoices(queryParams) {
  const { status, limit = '50', lastKey } = queryParams || {};

  let params = {
    TableName: TABLE,
    Limit: parseInt(limit, 10),
  };

  // Add pagination support
  if (lastKey) {
    params.ExclusiveStartKey = JSON.parse(decodeURIComponent(lastKey));
  }

  // Filter by status if provided
  if (status) {
    params = {
      ...params,
      IndexName: 'status-index',
      KeyConditionExpression: '#status = :status',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':status': status,
      },
    };

    const result = await dynamo.query(params).promise();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        invoices: result.Items,
        lastEvaluatedKey: result.LastEvaluatedKey
          ? encodeURIComponent(JSON.stringify(result.LastEvaluatedKey))
          : null,
        count: result.Count,
      }),
    };
  } else {
    // Scan all invoices
    const result = await dynamo.scan(params).promise();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        invoices: result.Items,
        lastEvaluatedKey: result.LastEvaluatedKey
          ? encodeURIComponent(JSON.stringify(result.LastEvaluatedKey))
          : null,
        count: result.Count,
      }),
    };
  }
}

async function updateInvoiceStatus(invoiceId, body) {
  if (!invoiceId) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invoice ID is required' }),
    };
  }

  const { status } = JSON.parse(body || '{}');

  if (!status) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Status is required' }),
    };
  }

  // First, get the current invoice to check its current status
  const currentInvoice = await dynamo
    .get({
      TableName: TABLE,
      Key: { invoiceId },
    })
    .promise();

  if (!currentInvoice.Item) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invoice not found' }),
    };
  }

  const currentStatus = currentInvoice.Item.status;

  // Define secure status transition rules
  const allowedTransitions = {
    pending: ['cancelled'], // pending can only go to cancelled
    cancelled: ['pending'], // cancelled can go back to pending
    paid: [], // paid cannot be changed (immutable)
    swept: [], // swept cannot be changed (immutable)
  };

  // Check if the transition is allowed
  if (!allowedTransitions[currentStatus] || !allowedTransitions[currentStatus].includes(status)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: `Invalid status transition: cannot change from '${currentStatus}' to '${status}'. Allowed transitions from '${currentStatus}': [${allowedTransitions[currentStatus].join(', ') || 'none'}]`,
      }),
    };
  }

  try {
    const result = await dynamo
      .update({
        TableName: TABLE,
        Key: { invoiceId },
        UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':status': status,
          ':updatedAt': new Date().toISOString(),
        },
        ConditionExpression: 'attribute_exists(invoiceId)',
        ReturnValues: 'ALL_NEW',
      })
      .promise();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result.Attributes),
    };
  } catch (error) {
    if (error.code === 'ConditionalCheckFailedException') {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invoice not found' }),
      };
    }
    throw error;
  }
}

async function deleteInvoice(invoiceId) {
  if (!invoiceId) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invoice ID is required' }),
    };
  }

  try {
    await dynamo
      .delete({
        TableName: TABLE,
        Key: { invoiceId },
        ConditionExpression:
          'attribute_exists(invoiceId) AND (#status = :pendingStatus OR #status = :cancelledStatus)',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':pendingStatus': 'pending',
          ':cancelledStatus': 'cancelled',
        },
      })
      .promise();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Invoice deleted successfully' }),
    };
  } catch (error) {
    if (error.code === 'ConditionalCheckFailedException') {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error:
            'Invoice not found or cannot be deleted (only pending and cancelled invoices can be deleted)',
        }),
      };
    }
    throw error;
  }
}
