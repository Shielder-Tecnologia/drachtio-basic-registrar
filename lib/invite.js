const parseUri = require('drachtio-srf').parseUri;
const axios = require('axios');
const config = require('config');
const Client = require('rtpengine-client').Client ;
const {isWSS, isPstnDestination} = require('./utils');
const {getSipUserForDid} = require('./userdb');
const rtpengine = new Client();
const offer = rtpengine.offer.bind(rtpengine, config.get('rtpengine'));
const answer = rtpengine.answer.bind(rtpengine, config.get('rtpengine'));
const del = rtpengine.delete.bind(rtpengine, config.get('rtpengine'));
const SipError = require('drachtio-srf').SipError;

module.exports = handler;

function handler(log) {
  return async(req, res) => {
    const logger = process.env.NODE_ENV === 'test' ? log : log.child({'Call-ID': req.get('Call-ID')});
    const srf = req.srf;
    const registrar = req.srf.locals.registrar;
    let from = req.get('From');
    logger.info(`incoming call to ${req.uri}`);
    req.uri = req.uri.split(";")[0];
    req.uri = req.uri.split(":")[0] + ':'+ req.uri.split(":")[1];
    let uri = parseUri(req.uri);
    
    

    logger.info(uri, `received ${req.method} from ${req.protocol}/${req.source_address}:${req.source_port}`);
    logger.info(req,'REQID');
    const callingNumber = req.callingNumber; // Ramal de origem
    const calledNumber = req.calledNumber;   // Ramal de destino
    const callId = req.callId || req.headers['call-id'];;               // Call-ID da chamada
    logger.info(callId ,'callid');
    const server = 'webrtc.shielder.com.br';
    const params = {
      params: {
        ramal_origem: callingNumber,
        ramal_destino: calledNumber,
        server: server,
        peer_id: callId,
      }
    }
    try {
      const responsereq = await axios.get('https://box.shielder.com.br/controle/getPushVoip.php', params);
      logger.info(`api#call request created responded  ${responsereq.request.path}`);
    } catch (err) {
      logger.error('Erro ao chamar getPushVoip2.php');
    }



    // figure out direction and transcoding needs of the call
    const response = await registrar.query(req.uri);
    const srcIsUsingSrtp = isWSS(req); // se quem ligou é wss
    let dstIsUsingSrtp = response && response.protocol && response.protocol.startsWith('ws'); // procura no bd se o dst tem ws
    const dstIsPstn = isPstnDestination(req);
    const sipUser = dstIsPstn ? getSipUserForDid(uri.user) : null; //pega o sipuser pelo did ou sip user mesmo
    


    
    // determine where to send the call
    let dest;
    const auth = {};
    if (response) { // procura pelo req.uri1005@domain.com
      dest = response.contact;
      logger.info(`call to a registered sip client at uri ${dest}`);
    }
    else if (sipUser) { // procura pelo did (pstn) se n for pstn
      const response = await registrar.query(sipUser);
      if (!response) return res.send(480, 'User Temporarily Unavailable');
      dest = response.contact;
      dstIsUsingSrtp = response.protocol && response.protocol.startsWith('ws');
      logger.info(`PSTN call to ${uri.user} routing to a registered sip client at uri ${dest}`);
    }
    else if (dstIsPstn) {
      const sipTrunk = config.get('sip-trunks.outbound');
      const hp = `${sipTrunk.host}:${sipTrunk.port || 5060}`;
      dest = `sip:${uri.user}@${hp}`;
      if (sipTrunk['default-ani']) {
        from = `<sip:${sipTrunk['default-ani']}@localhost>`;
      }
      logger.info(`call to a pstn number ${dest}`); // call para pstn
      if (sipTrunk.auth && sipTrunk.auth.username) Object.assign(auth, sipTrunk.auth);
    }
    else {
      logger.info(`incoming call to an unknown user ${req.uri}`);
      return res.send(404);
    }


    // make the outbound call
    const rtpEngineOpts = makeRtpEngineOpts(req, srcIsUsingSrtp, dstIsUsingSrtp);
    const deleteProxyFn = del.bind(rtpengine, rtpEngineOpts.common);
    try {
      // allocate an endpoint on rtpengine
      const response = await offer(rtpEngineOpts.offer);
      if ('ok' !== response.result) throw new Error(`failed allocating rtpe endpoint: ${JSON.stringify(response)}`);
      logger.info(`rtpengine#response returned ${JSON.stringify(response)}`);
      
      
      const {uas, uac} = await srf.createB2BUA(req, res, dest, {
        localSdpA: produceSdpUas.bind(null, logger, answer, rtpEngineOpts.answer), //sdp de quem ligou
        localSdpB: response.sdp, //sdp pra quem ta ligando
        proxyRequestHeaders: ['to', 'supported', 'allow', 'content-type', 'user-agent'],
        proxyResponseHeaders: ['accept', 'allow', 'allow-events'],
        headers: { from },
        auth
      });

      logger.info('call successfully connected');
      uas.other = uac;
      uac.other = uas;
      setHandlers(logger, uas, uac, deleteProxyFn);
    } catch (err) {
      if (err instanceof SipError) {
        logger.info(`Failed connecting outbound call sip status: ${err.status}`);
      }
      else logger.error(err, 'Error connecting call');
      deleteProxyFn();
    }
  };
}

async function produceSdpUas(logger, answer, opts, remoteSdp, res) {
  Object.assign(opts, {'sdp': remoteSdp, 'to-tag': res.getParsedHeader('To').params.tag});
  try {
    logger.info(`call ongoing1`);
    const response = await answer(opts);
    logger.info(`rtpengine#answer returnedd ${JSON.stringify(response)}`);
    return response.sdp;  
  } catch (err) {
    logger.error(err, 'Error calling rtpengine#answer');
  }
}

function makeRtpEngineOpts(req, srcIsUsingSrtp, dstIsUsingSrtp) {
  const from = req.getParsedHeader('from');
  const common = {'call-id': req.get('Call-ID'), 'from-tag': from.params.tag};
  const rtpCharacteristics = config.get('transcoding.rtpCharacteristics');
  const srtpCharacteristics = config.get('transcoding.srtpCharacteristics');
  return {
    common,
    offer: Object.assign({'sdp': req.body, 'replace': ['origin', 'session-connection']}, common,
      dstIsUsingSrtp ? srtpCharacteristics : rtpCharacteristics),
    answer: Object.assign({}, common, srcIsUsingSrtp ? srtpCharacteristics : rtpCharacteristics)
  };
}

function setHandlers(logger, uas, uac, deleteProxyFn) {
  [uas, uac].forEach((dlg) => {
    logger.info('call ongoing');
    // one side or the other hangs up
    dlg.on('destroy', () => {
      logger.info('call ended');
      dlg.other.destroy();
      deleteProxyFn()
        .then((results) => logger.debug(results, 'rtp stats'))
        .catch((err) => logger.error(err, 'Error deleting rtpengine endpoints'));
    });

    // proxy INFO to the other side
    dlg.on('info', (req, res) => {
      logger.info(`received info with content-type: ${req.get('Content-Type')}`);
      res.send(200) ;

      if (req.get('Content-Type') === 'application/media_control+xml') {
        dlg.other.request({
          method: 'INFO',
          headers: {
            'Content-Type': req.get('Content-Type'),
          },
          body: req.body
        });
      }
    });
  });
}
