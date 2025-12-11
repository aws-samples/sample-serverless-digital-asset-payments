const AWS = require('aws-sdk');
const dynamo = new AWS.DynamoDB.DocumentClient();

const TABLE = process.env.TABLE;

exports.handler = async event => {
  console.log('Event: ' + JSON.stringify(event, null, 2));

  const httpMethod = event.httpMethod;
  const path = event.path;
  const pathParameters = event.pathParameters;
  const queryStringParameters = event.queryStringParameters || {};

  try {
    if (httpMethod === 'GET' && path === '/invoices') {
      return await getAllInvoices(queryStringParameters);
    } else if (httpMethod === 'GET' && pathParameters?.invoiceId) {
      return await getInvoice(pathParameters.invoiceId);
    } else if (httpMethod === 'PUT' && pathParameters?.invoiceId) {
      const body = JSON.parse(event.body);
      return await updateInvoice(pathParameters.invoiceId, body);
    } else if (httpMethod === 'DELETE' && pathParameters?.invoiceId) {
      return await deleteInvoice(pathParameters.invoiceId);
    } else {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Not Found' }),
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

async function getAllInvoices(queryParams) {
  const status = queryParams.status;
  const limit = parseInt(queryParams.limit || '50', 10);
  const lastKey = queryParams.lastKey ? JSON.parse(queryParams.lastKey) : undefined;

  let params;

  if (status) {
    params = {
      TableName: TABLE,
      IndexName: 'status-index',
      KeyConditionExpression: '#s = :status',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':status': status },
      Limit: Math.min(limit, 100),
      ExclusiveStartKey: lastKey,
    };

    const result = await dynamo.query(params).promise();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        invoices: result.Items,
        lastKey: result.LastEvaluatedKey,
        count: result.Count,
      }),
    };
  } else {
    params = {
      TableName: TABLE,
      Limit: Math.min(limit, 100),
      ExclusiveStartKey: lastKey,
    };

    const result = await dynamo.scan(params).promise();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        invoices: result.Items,
        lastKey: result.LastEvaluatedKey,
        count: result.Count,
      }),
    };
  }
}

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

async function updateInvoice(invoiceId, body) {
  const { status } = body;

  if (!status) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Status is required' }),
    };
  }

  const getResult = await dynamo
    .get({
      TableName: TABLE,
      Key: { invoiceId },
    })
    .promise();

  if (!getResult.Item) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invoice not found' }),
    };
  }

  const currentStatus = getResult.Item.status;

  if (currentStatus === 'paid' || currentStatus === 'swept') {
    return {
      statusCode: 403,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Cannot modify paid or swept invoices',
      }),
    };
  }

  if (status !== 'pending' && status !== 'cancelled') {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Only pending and cancelled statuses are allowed',
      }),
    };
  }

  await dynamo
    .update({
      TableName: TABLE,
      Key: { invoiceId },
      UpdateExpression: 'set #s = :status, updatedAt = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':status': status,
        ':now': new Date().toISOString(),
      },
    })
    .promise();

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Invoice updated successfully' }),
  };
}

async function deleteInvoice(invoiceId) {
  const getResult = await dynamo
    .get({
      TableName: TABLE,
      Key: { invoiceId },
    })
    .promise();

  if (!getResult.Item) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invoice not found' }),
    };
  }

  const currentStatus = getResult.Item.status;

  if (currentStatus !== 'pending' && currentStatus !== 'cancelled') {
    return {
      statusCode: 403,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Only pending or cancelled invoices can be deleted',
      }),
    };
  }

  await dynamo
    .delete({
      TableName: TABLE,
      Key: { invoiceId },
    })
    .promise();

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Invoice deleted successfully' }),
  };
}
