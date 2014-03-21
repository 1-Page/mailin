'use strict';

var LanguageDetect = require('languagedetect');
var MailParser = require('mailparser').MailParser;
var _ = require('lodash');
var async = require('async');
var cheerio = require('cheerio');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var request = require('request');
var shell = require('shelljs');
var simplesmtp = require('simplesmtp');
var util = require('util');

var logger = require('./logger');
var mailUtilities = require('./mailUtilities');

var mailin = {
    options: {
        port: 2500,
        tmp: '.tmp',
        webhook: 'http://localhost:3000/webhook',
        logFile: null
    },

    start: function (options, callback) {
        options = options || {};
        if (_.isFunction(options)) {
            callback = options;
            options = {};
        }

        mailin.options = _.defaults(options, mailin.options);

        callback = callback || function () {};

        /* Create tmp dir if necessary. */
        if (!fs.existsSync(options.tmp)) {
            shell.mkdir('-p', options.tmp);
        }

        if (options.logFile) {
            logger.setLogFile(options.logFile);
        }

        var smtp = simplesmtp.createServer({
            SMTPBanner: 'Mailin Smtp Server',
            // debug: true
        });

        smtp.on('startData', function (connection) {
            logger.profile('message reception');
            logger.info('Receiving message from ' + connection.from);

            /* Create a write stream to a tmp file to which the incoming mail
             * will be streamed. */
            var mailPath = path.join(options.tmp, mailin._makeId());
            var mailWriteStream = fs.createWriteStream(mailPath);

            connection.mailPath = mailPath;
            connection.mailWriteStream = mailWriteStream;
        });

        smtp.on('data', function (connection, chunk) {
            connection.mailWriteStream.write(chunk);
        });

        smtp.on('dataReady', function (connection, cbConnection) {
            logger.profile('message reception');
            logger.profile('message processing');
            logger.info('Processing message from ' + connection.from);

            async.auto({
                retrieveRawEmail: function (cbAuto) {
                    fs.readFile(connection.mailPath, function (err, data) {
                        if (err) return cbAuto(err);
                        cbAuto(null, data.toString());
                    });
                },

                validateDkim: ['retrieveRawEmail',
                    function (cbAuto, results) {
                        var rawEmail = results.retrieveRawEmail;
                        mailUtilities.validateDkim(rawEmail, cbAuto);
                    }
                ],

                validateSpf: function (cbAuto) {
                    /* Get ip and host. */
                    mailUtilities.validateSpf(connection.remoteAddress,
                        connection.from, connection.host, cbAuto);
                },

                computeSpamScore: ['retrieveRawEmail',
                    function (cbAuto, results) {
                        var rawEmail = results.retrieveRawEmail;
                        mailUtilities.computeSpamScore(rawEmail, cbAuto);
                    }
                ],

                parseEmail: function (cbAuto) {
                    /* Prepare the mail parser. */
                    var mailParser = new MailParser();
                    mailParser.on('end', function (mail) {
                        logger.info(util.inspect(mail, {
                            depth: 5
                        }));

                        /* Make sure that both text and html versions of the
                         * body are available. */
                        if (!mail.text && !mail.html) {
                            mail.text = '';
                            mail.html = '<div></div>';
                        } else if (!mail.html) {
                            mail.html = mailin._convertTextToHtml(mail.text);
                        } else if (!mail.text) {
                            mail.text = mailin._convertHtmlToText(mail.html);
                        }

                        cbAuto(null, mail);
                    });

                    /* Stream the written email to the parser. */
                    var mailReadStream = fs.createReadStream(connection.mailPath);
                    mailReadStream.pipe(mailParser);
                },

                detectLanguage: ['parseEmail',
                    function (cbAuto, results) {
                        var text = results.parseEmail.text;

                        var language = '';
                        var languageDetector = new LanguageDetect();
                        var potentialLanguages = languageDetector.detect(text, 2);
                        if (potentialLanguages.length !== 0) {
                            logger.info('Potential languages: ' + util.inspect(potentialLanguages, {
                                depth: 5
                            }));

                            /* Use the first detected language.
                             * potentialLanguages = [['english', 0.5969], ['hungarian', 0.40563]] */
                            language = potentialLanguages[0][0];
                        } else {
                            logger.info('Unable to detect language for the current message.');
                        }

                        cbAuto(null, language);
                    }
                ],

                sendRequestToWebhook: ['validateDkim', 'validateSpf', 'computeSpamScore',
                    'parseEmail', 'detectLanguage',
                    function (cbAuto, results) {
                        var isDkimValid = results.validateDkim;
                        var isSpfValid = results.validateSpf;
                        var spamScore = results.computeSpamScore;
                        var parsedEmail = results.parseEmail;
                        var language = results.detectLanguage;

                        /* Finalize the parsed email object. */
                        parsedEmail.dkim = isDkimValid ? 'pass' : 'failed';
                        parsedEmail.spf = isSpfValid ? 'pass' : 'failed';
                        parsedEmail.spamScore = spamScore;
                        parsedEmail.language = language;

                        /* Send the request to the webhook. */
                        request.post(options.webhook).form({
                            mailinMsg: parsedEmail
                        }, function (err, resp, body) {
                            if (err || resp.statusCode !== 200) {
                                logger.info('Error in posting to webhook ' + options.webhook);
                                logger.info('Response status code: ' + resp.statusCode);
                                return cbAuto(err);
                            }

                            logger.info('Succesfully post to webhook ' + options.webhook);
                            logger.info(body);
                            return cbAuto(null);
                        });
                    }
                ]
            }, function (err) {
                if (err) logger.error(err);

                /* Don't forget to unlink the tmp file. */
                fs.unlink(connection.mailPath, function (err) {
                    if (err) logger.error(err);
                });

                logger.info('End processing message.');
                logger.profile('message processing');
            });

            /* Close the connection. */
            cbConnection(null, 'ABC1');
        });

        smtp.listen(options.port, function (err) {
            if (!err) {
                logger.info('Mailin Smtp server listening on port ' + options.port);
            } else {
                logger.error('Could not start server on port ' + options.port + '.');
                if (options.port < 1000) {
                    logger.error('Ports under 1000 require root privileges.');
                }

                logger.error(err.message);
            }

            callback(err);
        });
    },

    _makeId: function () {
        return crypto.randomBytes(20).toString('hex');
    },

    _convertTextToHtml: function (text) {
        /* Replace newlines by <br>. */
        text = text.replace(/(\n\r)|(\n)/g, '<br>');
        /* Remove <br> at the begining. */
        text = text.replace(/^\s*(<br>)*\s*/, '');
        /* Remove <br> at the end. */
        text = text.replace(/\s*(<br>)*\s*$/, '');

        return text;
    },

    _convertHtmlToText: function (html) {
        var $ = cheerio.load(html);
        return $.root().text();
    }

};

module.exports = mailin;