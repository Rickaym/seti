import { NOW } from './clock.js'

const offset = NOW - Date.now()
const realNow = Date.now.bind(Date)
Date.now = () => realNow() + offset
