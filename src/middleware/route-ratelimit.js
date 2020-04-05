'use strict'

const wlogger = require('../util/winston-logging')
const config = require('../../config')

const jwt = require('jsonwebtoken')

// Redis
const redisOptions = {
  enableOfflineQueue: false,
  port: process.env.REDIS_PORT ? process.env.REDIS_PORT : 6379,
  host: process.env.REDIS_HOST ? process.env.REDIS_HOST : '127.0.0.1'
}
console.log(`redisOptions: ${JSON.stringify(redisOptions, null, 2)}`)

const Redis = require('ioredis')
const redisClient = new Redis(redisOptions)

// Rate limiter middleware lib.
const { RateLimiterRedis } = require('rate-limiter-flexible')
const rateLimitOptions = {
  storeClient: redisClient,
  points: 100, // Number of points
  duration: 60 // Per minute (per 60 seconds)
}

let _this

class RateLimits {
  constructor () {
    _this = this

    this.jwt = jwt
    this.rateLimiter = new RateLimiterRedis(rateLimitOptions)
  }

  // Used to disconnect from the Redis DB.
  // Called by unit tests so that node.js thread doesn't live forever.
  closeRedis () {
    redisClient.disconnect()
  }

  async wipeRedis () {
    await redisClient.flushdb()
  }

  // This is the new rate limit function that uses the rate-limiter-flexible npm
  // library. It uses fine-grain rate limiting based on the resources being
  // consumed.
  async rateLimitByResource (req, res, next) {
    try {
      let userId
      let decoded = {}

      // Create a res.locals object if not passed in.
      if (!req.locals) {
        req.locals = {
          // default values
          jwtToken: '',
          proLimit: false,
          apiLevel: 0
        }
      }

      // Decode the JWT token if one exists.
      if (req.locals.jwtToken) {
        // const jwtOptions = {
        //   algorithms: ['ES256']
        // }

        // const pemPublicKey = keyEncoder.encodePublic(publicKey, 'raw', 'pem')

        // Validate the JWT token.
        // decoded = _this.jwt.verify(
        //   req.locals.jwtToken,
        //   pemPublicKey,
        //   jwtOptions
        // )

        console.log(`Last three letters of token secret: ${config.apiTokenSecret.slice(-3)}`)
        decoded = _this.jwt.verify(req.locals.jwtToken, config.apiTokenSecret)
        // console.log(`decoded: ${JSON.stringify(decoded, null, 2)}`)

        userId = decoded.id
      } else {
        wlogger.debug('No JWT token found!')
      }

      // Used for displaying error message. Default value is 3.
      let rateLimit = 3

      // Code here for the rate limiter is adapted from this example:
      // https://github.com/animir/node-rate-limiter-flexible/wiki/Overall-example#authorized-and-not-authorized-users
      try {
        // The resource being consumed: full node, indexer, SLPDB, etc.
        const resource = _this.getResource(req.url)
        wlogger.debug(`resource: ${resource}`)

        let key = userId || req.ip

        // const pointsToConsume = userId ? 1 : 30
        decoded.resource = resource
        const pointsToConsume = _this.calcPoints(decoded)

        wlogger.info(
          `User ${key} consuming ${pointsToConsume} point for resource ${resource}.`
        )

        rateLimit = Math.floor(100 / pointsToConsume)

        // Update the key so that rate limits track both the user and the resource.
        key = `${key}-${resource}`

        await _this.rateLimiter.consume(key, pointsToConsume)
      } catch (err) {
        // console.log(`err: `, err)

        // Rate limited was triggered
        res.status(429) // https://github.com/Bitcoin-com/rest.bitcoin.com/issues/330
        return res.json({
          error: `Too many requests. Your limits are currently ${rateLimit} requests per minute. Increase rate limits at https://fullstack.cash`
        })
      }
    } catch (err) {
      wlogger.error('Error in route-ratelimit.js/newRateLimit(): ', err)
      // throw err
    }

    next()
  }

  // Calculates the points consumed, based on the jwt information and the route
  // requested.
  calcPoints (jwtInfo) {
    let retVal = 30 // By default, use anonymous tier.

    try {
      // console.log(`jwtInfo: ${JSON.stringify(jwtInfo, null, 2)}`)

      const apiLevel = jwtInfo.apiLevel
      const resource = jwtInfo.resource

      const level30Routes = ['insight', 'bitcore', 'blockbook']
      const level40Routes = ['slp']

      wlogger.debug(`apiLevel: ${apiLevel}`)

      // Only evaluate if user is using a JWT token.
      if (jwtInfo.id) {
        // SLP indexer routes
        if (level40Routes.includes(resource)) {
          if (apiLevel >= 40) retVal = 1
          // else if (apiLevel >= 10) retVal = 10
          else retVal = 10

          // Normal indexer routes
        } else if (level30Routes.includes(resource)) {
          if (apiLevel >= 30) retVal = 1
          else retVal = 10

          // Full node tier
        } else if (apiLevel >= 20) {
          retVal = 1

          // Free tier, full node only.
        } else {
          retVal = 10
        }
      }

      return retVal
    } catch (err) {
      wlogger.error('Error in route-ratelimit.js/calcPoints()')
      // throw err
      retVal = 30
    }

    return retVal
  }

  // This function parses the req.url property to identify what resource
  // the user is requesting.
  // This was created as a function so that it can be unit tested. Not sure
  // what kind of variations will be seen in production.
  getResource (url) {
    try {
      wlogger.debug(`url: ${JSON.stringify(url, null, 2)}`)

      const splitUrl = url.split('/')
      const resource = splitUrl[1]

      return resource
    } catch (err) {
      wlogger.error('Error in getResource().')
      throw err
    }
  }
}

module.exports = RateLimits
