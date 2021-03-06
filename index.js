const http = require('http')
const chalk = require('chalk')
const MustHave = require('musthave')
const mh = new MustHave({
  throwOnError: false
})
const LaunchTime = (new Date()).toISOString()

const getRandomValues = buf => {
  if (!(buf instanceof Uint8Array)) {
    throw new TypeError('expected Uint8Array')
  }

  if (buf.length > 65536) {
    let e = new Error()
    e.code = 22
    e.message = 'Failed to execute \'getRandomValues\' on \'Crypto\': The ' +
      'ArrayBufferView\'s byte length (' + buf.length + ') exceeds the ' +
      'number of bytes of entropy available via this API (65536).'
    e.name = 'QuotaExceededError'

    throw e
  }

  let bytes = require('crypto').randomBytes(buf.length)
  buf.set(bytes)

  return buf
}

function priv (value) {
  return { enumerable: false, writable: true, configurable: false, value }
}

const ERROR_TYPES = new Set(['json', 'text'])
const COMMON_HEADERS = new Set(['Origin', 'X-Requested-With', 'Content-Type', 'Accept'])
const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH'])

class Endpoint {
  constructor () {
    Object.defineProperties(this, {
      __errorType: priv('text'),
      // __allowedMethods: priv(new Set()),
      // __allowedHeaders: priv(new Set()),
      // __allowedOrigins: priv(new Set()),
      __logRedirects: priv(false)
    })

    // Add all known HTTP statuses
    Object.keys(http.STATUS_CODES).forEach(status => {
      Object.defineProperty(this, `HTTP${status}`, {
        enumerable: true,
        writable: false,
        configurable: false,
        value: (req, res) => res.sendStatus(status)
      })

      Object.defineProperty(this, `${http.STATUS_CODES[status].replace(/\s+|-+/, '_').replace(/[^A-Z_]/gi, '').toUpperCase()}`, {
        enumerable: true,
        writable: false,
        configurable: false,
        value: (req, res, next) => this[`HTTP${status}`](req, res, next)
      })
    })
  }

  set errorType (value) {
    value = (value || 'text').trim().toLowerCase()
    if (!ERROR_TYPES.has(value)) {
      value = 'text'
    }

    this.__errorType = value
  }

  get commonHeaders () {
    return Array.from(COMMON_HEADERS)
  }

  get httpMethods () {
    return Array.from(HTTP_METHODS)
  }

  // Last argument must be a callback.
  validateJsonBody () {
    let args = Array.from(arguments)
    return (req, res, next) => {
      if (!req.hasOwnProperty('body') || typeof req.body !== 'object') {
        return this.replyWithError(res, 400, 'No JSON body supplied.')
      }

      if (args.length === 0) {
        return next()
      }

      if (!mh.hasAll(req.body, ...args)) {
        return this.replyWithError(res, 400, `Missing parameters: ${mh.missing.join(', ')}`)
      }

      next()
    }
  }

  // Adds an `id` attribute to the request object.
  validNumericId (parameter = 'id') {
    return (req, res, next) => {
      if (!req.params[parameter]) {
        return this.replyWithError(res, 400, 'No ID specified in URL.')
      }

      try {
        let id = parseInt(req.params[parameter], 10)

        if (isNaN(id)) {
          throw new Error(`"${req.params[parameter]}" is an invalid numeric ID.`)
        }

        req.id = id
        next()
      } catch (e) {
        return this.replyWithError(res, 400, e.message)
      }
    }
  }

  // Adds an `id` attribute to the request object.
  validId (parameter = 'id') {
    return (req, res, next) => {
      if (!req.params[parameter]) {
        return this.replyWithError(res, 400, 'No ID specified in URL.')
      }

      try {
        let id = req.params[parameter].trim()
        if (id.length === 0) {
          throw new Error(`"${req.params[parameter]}" is an invalid ID.`)
        }

        req.id = id
        next()
      } catch (e) {
        return this.replyWithError(res, 400, e.message)
      }
    }
  }

  // validResult (res, callback) {
  //   return (err, result) => {
  //     if (err) {
  //       if (err.message.indexOf('does not exist')) {
  //         return this.replyWithError(res, 404, err)
  //       }
  //
  //       return this.replyWithError(res, 500, err)
  //     }
  //
  //     callback(result)
  //   }
  // }

  // ASCII to Binary
  // This mimics the browser's window.atob function.
  // This is used to extract username/password from a request.
  atob (str) {
    return Buffer.from(str, 'base64').toString('binary')
  }

  /**
   * This method will perform basic authentication.
   * It will compare the authentication header credentials
   * with the username and password.
   *
   * For example, `basicauth('user', 'passwd')` would compare the
   * user-submitted username/password to `user` and `passwd`. If
   * they do not match, a 401 (Not Authorized) response is sent.
   *
   * It is also possible to perform a more advanced authentication
   * using a custom function. For example:
   *
   * ```
   * basicauth(function (username, password, grantedFn, deniedFn) {
   *   if (confirmWithDatabase(username, password)) {
   *     grantedFn()
   *   } else {
   *     deniedFn()
   *   }
   * })
   * ```
   *
   * The `username`/`password` will be supplied in plain text. The
   * `grantedFn()` should be run when user authentication succeeds,
   * and the `deniedFn()` should be run when it fails.
   * @param  {string} username
   * The username to compare credentials with.
   * @param  {string} password
   * The password to compare credentials with.
   */
  basicauth (username, password) {
    return (req, res, next) => {
      if (req.get('Authorization')) {
        let credentials = (req.get('authorization')).split(/\s+/i).pop()

        if (credentials && credentials.trim().length > 0) {
          credentials = this.atob(credentials).split(':')

          if (credentials.length === 2) {
            // If an authentication function is provided, use it
            if (typeof username === 'function') {
              return username(credentials[0], credentials[1], () => {
                req.user = credentials[0]
                next()
              }, () => {
                res.set('WWW-Authenticate', `Basic realm=${req.get('host')}`)
                return res.sendStatus(401)
              })
            } else if (credentials[0] === username && credentials[1] === password) {
              req.user = username
              return next()
            }
          }
        }
      }

      res.set('WWW-Authenticate', `Basic realm=${req.get('host')}`)
      return res.sendStatus(401)
    }
  }

  /**
   * This method accepts a bearer token in the Authorization request header.
   * For example, the request header ma look like:
   *
   * `Authorization: bearer 123myToken456`
   *
   * The token is `123myToken456`. The middleware for this
   * token would be applied as follows:
   *
   * ```javascript
   * app.get('/mypath', Endpoint.bearer('123myToken456'), ...)
   * ```
   * @param {string|function} token
   * The token can be a single string or a **synchronous** function that resolves to a **boolean** (i.e. `true` if the token is valid or `false` if it is not).
   * The function will receive the token and request as the argument.
   * @param {boolean} [caseSensitive=true]
   * Determines whether the token comparison should be case sensitive or not.
   * This is ignored if the token argument is a custom function.
   */
  bearer (token, caseSensitive = true) {
    return (req, res, next) => {
      if (req.get('authorization')) {
        let input = req.get('authorization').replace(/^(\s+)?bearer(\s+)?/i, '')

        if (typeof token === 'function') {
          let data = token(input)
          return data ? () => { req.user = data; next() } : res.sendStatus(401)
        }

        if (!caseSensitive) {
          input = input.toLowerCase()
          token = token.toLowerCase()
        }

        if (input === token) {
          req.user = token
          return next()
        }
      }

      res.sendStatus(401)
    }
  }

  litmusTest (content = 'LITMUS TEST') {
    return (req, res, next) => {
      console.log(chalk.cyan(content))
      next()
    }
  }

  logErrors (err, req, res, next) {
    if (err) {
      console.log(chalk.red.bold(err.message))

      if (typeof next !== 'function') {
        return res.status(500).send(err.message)
      }
    }

    next()
  }

  log (req, res, next) {
    console.log(chalk.dim(`${(new Date()).toLocaleTimeString()}: `) + Endpoint.color(req.method)(req.method) + chalk.dim(` ${req.url}`))
    next()
  }

  // Middleware for displaying headers.
  // This is useful for identifying headers sourced
  // from an API gateway or downstream proxy.
  logRequestHeaders (req, res, next) {
    Object.keys(req.headers).forEach(header => console.log(chalk.cyan.bold(header.toLowerCase()) + ' --> ' + chalk.cyan(req.get(header))))
    next()
  }

  logRedirects (v = true) {
    this.__logRedirects = v
  }

  static color (method) {
    return function () {
      let response = ''

      switch ((method || 'unknown').trim().toLowerCase()) {
        case 'post':
          response = chalk.bgGreen.white(...arguments)
          break

        case 'put':
          response = chalk.bgYellow.black(...arguments)
          break

        case 'delete':
          response = chalk.bgRed.white(...arguments)
          break

        case 'get':
          response = chalk.bgMagenta.black(...arguments)
          break

        case 'head':
          response = chalk.bgBlue.white(...arguments)
          break

        case 'trace':
          response = chalk.bgCyan.black(...arguments)
          break

        default:
          response = chalk.bgWhite.black.dim(...arguments)
          break
      }

      return response
    }
  }

  applyCommonConfiguration (app, autolog = true) {
    // Rudimentary "security"
    app.disable('x-powered-by')

    // Basic logging
    if (autolog) {
      app.use(this.log)
    }

    // Healthcheck
    const version = JSON.parse(require('fs').readFileSync(require('path').join(process.cwd(), 'package.json')).toString()).version
    app.get('/ping', (req, res) => res.sendStatus(200))
    app.get('/version', (req, res) => res.status(200).send(version))
    app.get('/info', (req, res) => res.status(200).json({
      runningSince: LaunchTime,
      version,
      routes: Array.from(app._router ? app._router.stack : app.router || []).filter(r => r.route).map(r => r.route.path)
    }))
  }

  applySimpleCORS (app, host = '*') {
    if (arguments.length > 2) {
      host = Array.from(arguments)
      host.shift()
    }

    app.use((req, res, next) => {
      this.allowOrigins(host)(req, res)
      this.allowHeaders(...this.commonHeaders)(req, res)
      this.allowMethods('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS')(req, res)

      // Support preflight requests
      this.allowPreflight(req, res, next)
    })
  }

  allowAll (host = '*') {
    return (req, res, next) => {
      const methods = new Set(Array.from(HTTP_METHODS).slice(0))

      this.allowOrigins(...(arguments.length > 0 ? arguments : [host]))(req, res)
      this.allowMethods(...Array.from(methods))(req, res)
      this.allowHeaders(...Object.keys(req.headers))(req, res)
      this.allowPreflight()(req, res, next)
    }
  }

  allowPreflight () {
    return (req, res, next) => {
      if (req.method.toUpperCase() === 'OPTIONS') {
        if (req.headers['access-control-request-headers']) {
          this.allowHeaders(...req.headers['access-control-request-headers'].split(','))(req, res)
        }
        return res.sendStatus(200)
      }

      next()
    }
  }

  allowMethods () {
    return (req, res, next) => {
      // Deduplicates methods
      res.setHeader('Access-Control-Allow-Methods', Array.from(new Set(Array.from(arguments).map(m => m.toUpperCase()))))

      if (next) {
        next()
      }
    }
  }

  allowHeaders () {
    return (req, res, next) => {
      // Deduplicates headers
      res.setHeader('Access-Control-Allow-Headers', Array.from(new Set(Array.from(arguments).map(h => h.toLowerCase()))))

      if (next) {
        next()
      }
    }
  }

  allowOrigins (host) {
    if (!Array.isArray(host) && arguments.length > 1) {
      host = Array.from(arguments)
    }

    return (req, res, next) => {
      if (host === '*' || host.indexOf('*') >= 0) {
        try {
          // Do not block localhost, regardless of port.
          // Common use case: Running a web server and API
          // server on separate ports during dev, but under
          // the same context (i.e. mimicking a production domain)
          host = req.get('origin') || req.get('referer') || host
          host = host.indexOf('localhost') >= 0 ? host : '*'
        } catch (e) {
          console.log(e)
        }
      } else if (Array.isArray(host)) {
        host = host.filter(h => h.trim().length > 0).map(h => h.toLowerCase())

        const index = host.indexOf(req.get('host').toLowerCase())
        if (index >= 0) {
          host = host[index]
        } else {
          host = host[0] || req.get('host')
        }
      }

      res.setHeader('Access-Control-Allow-Origin', host)

      if (next) {
        next()
      }
    }
  }

  /**
   * A helper method for dumping data into a response.
   * @param {any} data
   * This can be an object or a JavaScript primitive (string, number, etc)
   */
  reply (data) {
    if (typeof data !== 'object') {
      try {
        data = JSON.parse(data)
      } catch (e) {
        data = data.toString()
      }
    }

    return (req, res) => {
      if (typeof data === 'object') {
        res.json(data)
      } else {
        res.send(data)
      }
    }
  }

  replyWithMaskedError (res, status = 500, message = 'Server Error') {
    let txnId = this.createUUID()

    if (arguments[arguments.length - 1] instanceof Error) {
      status = typeof status === 'number' ? status : 400
      message = arguments[arguments.length - 1].message
    }

    console.log(`[ERROR:${txnId}] (${status}) ${message}`)

    this.replyWithError(res, status, `An error occurred. Reference: ${txnId}`)
  }

  replyWithError (res, status = 500, message = 'Server Error') {
    // If the last argument is an error, use it.
    // if (arguments.length > 0) {//arguments[arguments.length - 1]) {
    if (arguments[arguments.length - 1] instanceof Error) {
      status = typeof status === 'number' ? status : 400
      message = arguments[arguments.length - 1].message
    }

    if (status >= 500) {
      console.log('server.incident', {
        name: 'Server Error',
        message: message
      })
    }

    res.statusMessage = message
    if (this.__errorType === 'json') {
      res.status(status).json({ status, message })
    } else {
      res.status(status).send(message)
    }
  }

  /**
   * Redirect the request to another location.
   * @param {string} url
   * The location to redirect to.
   * @param {boolean} [permanent=false]
   * Instruct the client that the redirect is permanent,
   * suggesting all future requests should be made directly
   * to the new location. When this is `false`, a HTTP `307`
   * code is returned. When `true`, a HTTP `308` is returned.
   * @param {boolean} [moved=false]
   * Inform the client that the destination has been moved.
   * When _moved_ is `true` and _permanent_ is `false`, an
   * HTTP `303` (Found) status is returned, informing the
   * client the request has been received and a `GET` request
   * should be issued to the new location to retrieve it. When
   * _permanent_ is `true`, a HTTP `301` is returned,
   * indicating all future requests should be made directly to
   * the new location.
   */
  redirect (url, permanent = false, moved = false) {
    return (req, res) => {
      if (this.__logRedirects) {
        console.log(`Redirect ${chalk.dim.yellow(req.method.toUpperCase() + ' ' + chalk.bold(req.url))} ${chalk.dim('→')} ${chalk.blueBright(url)}`)
      }

      const code = permanent ? (moved ? 301 : 308) : (moved ? 303 : 307)

      // Identify relative redirect
      if (!/^\w+:\/{2}/i.test(url)) {
        let uri = `${req.protocol}://${req.headers.host || req.host || req.hostname}`

        if (/^\.+\//.test(url)) {
          uri += req.path + '/' + url
        } else {
          uri += ('/' + url).replace(/^\/{2,}/, '/')
        }

        url = uri
      }

      res.header('location', url)
      res.sendStatus(code)
    }
  }

  // Create a UUIDv4 unique ID.
  createUUID () {
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
      (c ^ getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
    )
  }

  applyBaseUrl (req, route = '/', forceTLS = false) {
    return `${forceTLS ? 'https' : req.protocol}://${req.get('host')}${route}`
  }

  applyRelativeUrl (req, route = '/', forceTLS = false) {
    return `${forceTLS ? 'https' : req.protocol}://${req.get('host')}${req.path}${route}`
  }
}

const API = new Endpoint()
module.exports = API
