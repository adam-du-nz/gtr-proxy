import { proxyPathnameToAzBlobSASUrl } from './azb'
import { serializeError } from 'serialize-error'

export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url)

  if (url.pathname.startsWith('/p/')) {
    return handleProxyToGoogleTakeoutRequest(request)
  }

  if (url.pathname.startsWith('/p-azb/')) {
    return handleProxyToAzStorageRequest(request)
  }

  if (url.pathname.startsWith('/t-azb/')) {
    return handleFullTransloadFromGoogleTakeoutToAzBlobRequest(request)
  }

  if (url.pathname.startsWith('/version/')) {
    return new Response(
      JSON.stringify(
        {
          apiVersion: '2.0.0',
        },
        null,
        2,
      ),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }

  // Check if the URL matches the path desired. If not, just redirect to GitHub
  // for project information
  return new Response(null, {
    status: 302,
    headers: {
      Location: 'https://github.com/nelsonjchen/gtr-proxy#readme',
    },
  })
}

export async function handleProxyToGoogleTakeoutRequest(
  request: Request,
): Promise<Response> {
  // Extracted URL is after the /p/ in the path with https:// prepended to it
  const original_url_segment = `https://${request.url.substring(
    request.url.indexOf('/p/') + 3,
  )}`

  // Strip off "/dummy.bin" from the end of the URL if it is there.
  // This allows testing with azcopy which requires a nice filename at the end.
  const original_url_segment_stripped = original_url_segment.replace(
    /\/dummy.bin$/,
    '',
  )

  // Replace %25 with % to get the original URL
  const original_url_segment_stripped_processed =
    original_url_segment_stripped.replace(/%25/g, '%')

  let extracted_url: URL
  try {
    // Replace %25 with % to get the original URL
    extracted_url = new URL(original_url_segment_stripped_processed)
  } catch (_) {
    return new Response('invalid URL', {
      status: 500,
    })
  }

  if (
    !(validGoogleTakeoutUrl(extracted_url) || validTestServerURL(extracted_url))
  ) {
    return new Response(
      'encoded url was not a google takeout or test server url',
      {
        status: 403,
      },
    )
  }

  const originalResponse = await fetch(extracted_url.toString(), {
    method: request.method,
    headers: request.headers,
  })

  const response = new Response(originalResponse.body, {
    status: originalResponse.status,
    headers: originalResponse.headers,
  })

  console.log(response)

  return response
}

export async function handleProxyToAzStorageRequest(
  request: Request,
): Promise<Response> {
  const url = new URL(request.url)
  try {
    const azUrl = proxyPathnameToAzBlobSASUrl(url)
    const originalResponse = await fetch(azUrl.toString(), {
      method: request.method,
      headers: request.headers,
    })

    const response = new Response(originalResponse.body, {
      status: originalResponse.status,
      headers: originalResponse.headers,
    })
    console.log(`response: ${JSON.stringify(response)}`)

    return response
  } catch {
    return new Response('invalid URL', {
      status: 500,
    })
  }
}

export async function handleFullTransloadFromGoogleTakeoutToAzBlobRequest(
  request: Request,
): Promise<Response> {
  // These headers go to Azure
  const toAzureHeaders = new Headers()
  // These headers go to the source
  const copySourceHeaders = new Headers()

  // Copy all headers from the request that astart with x-ms- to the Azure headers
  for (const [key, value] of request.headers) {
    if (key.startsWith('x-ms-')) {
      toAzureHeaders.set(key, value)
    }
  }

  // Check for a 'x-gtr-copy-source' header
  const copySource = request.headers.get('x-gtr-copy-source')
  if (!copySource) {
    return new Response('missing x-gtr-copy-source header', {
      status: 400,
    })
  }

  // If a x-gtr-copy-source-range exists, process it
  // x-gtr-copy-source-range format is like "bytes=start-end"
  const copySourceRange = request.headers.get('x-gtr-copy-source-range')
  if (copySourceRange) {
    // toAzureHeaders.delete('x-gtr-copy-source-range')
    // Set the length header to the length of the range
    const rangeParts = copySourceRange.split('=')
    if (rangeParts.length !== 2) {
      return new Response('invalid x-gtr-copy-source-range header', {
        status: 400,
      })
    }
    const range = rangeParts[1]
    const rangeBounds = range.split('-')
    if (rangeBounds.length !== 2) {
      return new Response('invalid x-gtr-copy-source-range header', {
        status: 400,
      })
    }
    const start = parseInt(rangeBounds[0])
    const end = parseInt(rangeBounds[1])
    if (isNaN(start) || isNaN(end)) {
      return new Response('invalid x-gtr-copy-source-range header', {
        status: 400,
      })
    }
    const length = end - start + 1
    toAzureHeaders.set('Content-Length', length.toString())
  }

  // Get a readable stream of the request body from the url of x-gtr-copy-source
  const copySourceUrl = new URL(copySource)
  // Make sure hostname is a valid test server or google URL
  if (
    !validGoogleTakeoutUrl(copySourceUrl) &&
    !validTestServerURL(copySourceUrl)
  ) {
    return new Response(
      'invalid x-gtr-copy-source header: not takeout url or test server url',
      {
        status: 403,
      },
    )
  }
  console.log('fetching original file from', copySourceUrl.href)
  const sourceRange = request.headers.get('x-gtr-copy-source-range')
  if (sourceRange) {
    copySourceHeaders.set('Range', sourceRange)
    console.log('setting range header', sourceRange)
  }

  const copySourceResponse = await fetch(copySourceUrl.toString(), {
    method: 'GET',
    headers: copySourceHeaders,
  })

  console.log('original file response status', copySourceResponse.status)
  // If the original request has some sort of error, return that error
  if (!copySourceResponse.ok) {
    return new Response(copySourceResponse.body, {
      status: copySourceResponse.status,
      headers: copySourceResponse.headers,
    })
  }
  // Get a readable stream of the original
  const copySourceBody = copySourceResponse.body
  // Return an error if body isn't a ReadableStream
  if (!(copySourceBody instanceof ReadableStream)) {
    return new Response('copySourceBody is not a ReadableStream', {
      status: 500,
    })
  }
  // Set content length of toAzureHeaders to the content length of the source
  toAzureHeaders.set(
    'Content-Length',
    copySourceResponse.headers.get('Content-Length') || '0',
  )

  // remove all upstream that start with cloudflare stuff
  for (const [key, _] of toAzureHeaders.entries()) {
    if (key.startsWith('cf-')) {
      toAzureHeaders.delete(key)
    }
  }

  const url = new URL(request.url)
  try {
    const azUrl = proxyPathnameToAzBlobSASUrl(url)
    console.log('proxying to', azUrl)

    console.log(
      'toAzureHeaders',
      JSON.stringify(Object.fromEntries(toAzureHeaders.entries())),
    )
    const originalResponse = await fetch(azUrl.toString(), {
      method: request.method,
      headers: toAzureHeaders,
      body: copySourceBody,
    })

    const body2 = await originalResponse.text()

    console.log('az response status', originalResponse.status)
    console.log('az response body', body2)

    const response = new Response(body2, {
      status: originalResponse.status,
      headers: originalResponse.headers,
    })

    return response
  } catch (e) {
    if (e instanceof Error) {
      const error = serializeError(e)
      return new Response(JSON.stringify(error), {
        status: 500,
      })
    }
    return new Response('unknown error', {
      status: 500,
    })
  }
}

export function validTestServerURL(url: URL): boolean {
  return (
    // Cloudflare Bucket test server with unlimited download bandwidth
    url.hostname.endsWith('gtr-test.677472.xyz') ||
    // https://github.com/nelsonjchen/put-block-from-url-esc-issue-demo-server/
    url.hostname.endsWith('3vngqvvpoq-uc.a.run.app')
  )
}

export function validGoogleTakeoutUrl(url: URL): boolean {
  return (
    (url.hostname.endsWith('apidata.googleusercontent.com') &&
      (url.pathname.startsWith('/download/storage/v1/b/dataliberation/o/') ||
        url.pathname.startsWith('/download/storage/v1/b/takeout'))) ||
    url.hostname.endsWith('storage.googleapis.com')
  )
}
