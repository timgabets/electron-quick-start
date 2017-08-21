const StatesService = require('../services/states.js');
const ScreensService = require('../services/screens.js');
const FITsService = require('../services/fits.js');
const Trace = require('../controllers/trace.js');
const Pinblock = require('../controllers/pinblock.js');
const DES3 = require('../controllers/des3.js');

function ATM(settings, log) {
  /**
   * [isFDKButtonActive check whether the FDKs is active or not]
   * @param  {[type]}  button [FDK button to be checked, e.g. 'A', 'G' (case does not matter - 'a', 'g' works as well) ]
   * @return {Boolean}        [true if FDK is active, false if inactive]
   */
  this.isFDKButtonActive = function(button){
    if(!button)
      return;

    for (var i = 0; i < this.activeFDKs.length; i++)
      if(button.toUpperCase() === this.activeFDKs[i] )
        return true; 
    
    return false;
  }

  /**
   * [setFDKsActiveMask set the current FDK mask ]
   * @param {[type]} mask [number from 000 to 255, represented as string]
   */
  this.setFDKsActiveMask = function(mask){
    if(mask > 255){
      log.error('Invalid FDK mask: ' + mask);
      return;
    }

    this.activeFDKs = [];
    var FDKs = ['A', 'B', 'C', 'D', 'F', 'G', 'H', 'I'];
    for(var bit = 0; bit < 8; bit++)
      if((mask & Math.pow(2, bit)).toString() !== '0')
        this.activeFDKs.push(FDKs[bit]);
  }

  /**
   * [replySolicitedStatus description]
   * @param  {[type]} status [description]
   * @return {[type]}        [description]
   */
  this.replySolicitedStatus = function(status){
    var reply = {};
    reply.message_class = 'Solicited';
    reply.message_subclass = 'Status'; 

    switch(status){
      case 'Ready':
      case 'Command Reject':
      case 'Specific Command Reject':
        reply.status_descriptor = status;
        break;
      default:
        log.info('atm.replySolicitedStatus(): unknown status ' + status);
        reply.status_descriptor = 'Command Reject';
    }
    return reply;
  };

  /**
   * [processTerminalCommand description]
   * @param  {[type]} data [description]
   * @return {[type]}      [description]
   */
  this.processTerminalCommand = function(data){
    switch(data.command_code){
      case 'Go out-of-service':
        this.status = 'Out-Of-Service';
        break;
      case 'Go in-service':
        this.status = 'In-Service';
        //this.processState('000');
        break;
      default:
          log.info('atm.processTerminalCommand(): unknown command code: ' + data.command_code);
          return this.replySolicitedStatus('Command Reject');
        }
      return this.replySolicitedStatus('Ready');
  } 

  /**
   * [processCustomizationCommand description]
   * @param  {[type]} data [description]
   * @return {[type]}      [description]
   */
  this.processCustomizationCommand = function(data){
    switch(data.message_identifier){
      case 'Screen Data load':
        if(this.screens.add(data.screens))
          return this.replySolicitedStatus('Ready') 
        else
          return this.replySolicitedStatus('Command Reject');

      case 'State Tables load':
        if(this.states.add(data.states))
          return this.replySolicitedStatus('Ready') 
        else
          return this.replySolicitedStatus('Command Reject');

      case 'FIT Data load':
        if(this.FITs.add(data.FITs))
          return this.replySolicitedStatus('Ready')
        else
          return this.replySolicitedStatus('Command Reject');

      case 'Configuration ID number load':
        if(data.config_id){
          this.config_id = data.config_id;
          return this.replySolicitedStatus('Ready');
        }else{
          log.info('ATM.processDataCommand(): wrong Config ID');
          return this.replySolicitedStatus('Command Reject');
        }
        break;

      default:
        log.error('ATM.processDataCommand(): unknown message identifier: ', data.message_identifier);
        return this.replySolicitedStatus('Command Reject');
    }
    return this.replySolicitedStatus('Command Reject');
  };

  /**
   * [dec2hex convert decimal string to hex string, e.g. 040198145193087203201076202216192211251240251237 to 28C691C157CBC94CCAD8C0D3FBF0FBED]
   * @param  {[type]} dec_string [decimal string ]
   * @return {[type]}            [hex string]
   */
  this.dec2hex = function (dec_string){
    var hex_string = '';
    for(var i = 0; i < dec_string.length; i += 3){
      var chunk = parseInt(dec_string.substr(i, 3)).toString(16);
      (chunk.length === 1) ? (hex_string = hex_string + '0' + chunk ) : hex_string += chunk;
    }

    return hex_string.toUpperCase();
  }

  this.processExtendedEncKeyInfo = function(data){
    switch(data.modifier){
      case 'Decipher new comms key with current master key':
        // data.new_ney_data
        break;

      default:
        log.error('Unsupported modifier');
        break;
    }

    return this.replySolicitedStatus('Command Reject');
  }

  /**
   * [processDataCommand description]
   * @param  {[type]} data [description]
   * @return {[type]}      [description]
   */
  this.processDataCommand = function(data){
    switch(data.message_subclass){
      case 'Customization Command':
        return this.processCustomizationCommand(data);

      case 'Interactive Transaction Response':
        return this.processInteractiveTransactionResponse(data);

      case 'Extended Encryption Key Information':
        return this.processExtendedEncKeyInfo(data);
        
      default:
        log.info('atm.processDataCommand(): unknown message sublass: ', data.message_subclass);
        return this.replySolicitedStatus('Command Reject');
    }
    return this.replySolicitedStatus('Command Reject');
  }

  /**
   * [processTransactionReply description]
   * @param  {[type]} data [description]
   * @return {[type]}      [description]
   */
  this.processTransactionReply = function(data){
    // TODO: processing next_state
    this.processState(data.next_state);
    return this.replySolicitedStatus('Ready');
  };


  /**
   * [getMessageCoordinationNumber 
   *  Message Co-Ordination Number is a character assigned by the
   *  terminal to each transaction request message. The terminal assigns a
   *  different co-ordination number to each successive transaction request,
   *  on a rotating basis. Valid range of the co-ordination number is 31 hex
   *  to 3F hex, or if enhanced configuration parameter 34 ‘MCN Range’ has
   *  been set to 001, from 31 hex to 7E hex. Central must include the
   *  corresponding co-ordination number when responding with a
   *  Transaction Reply Command.
   *  
   *  This ensures that the Transaction Reply matches the Transaction
   *  Request. If the co-ordination numbers do not match, the terminal
   *  sends a Solicited Status message with a Command Reject status.
   *  Central can override the Message Co-Ordination Number check by
   *  sending a Co-Ordination Number of ‘0’ in a Transaction Reply
   *  command. As a result, the terminal does not verify that the
   *  Transaction Reply co-ordinates with the last transaction request
   *  message.]
   * @return {[type]} [description]
   */
  this.getMessageCoordinationNumber = function(){
    var saved = settings.get('message_coordination_number');
    if(!saved)
      saved = '\x31';

    saved = (parseInt(saved) + 1).toString();

    if(saved > '\x3F')
      saved = '\x31';

    settings.set('message_coordination_number', saved);
    return saved;
  } 

  /**
   * [getEncryptedPIN description]
   * @return {[type]}           [description]
   */
  this.getEncryptedPIN = function(){
    var atm_pinblock = this.des3.encrypt(this.terminal_pin_key, this.pinblock.get(this.PIN_buffer, this.card.number));
    return this.pinblock.encode_to_atm_format(atm_pinblock);
  }

  /**
   * [initBuffers clears the terminal buffers
   * When the terminal enters the Card Read State, the following buffers are initialized:
   *  - Card data buffers (no data)
   *  - PIN and General Purpose buffers (no data)
   *  - Amount buffer (zero filled)
   *  - Operation code buffer (space filled)
   *  - FDK buffer (zero filled)]
   * @return {[type]} [description]
   */
  this.initBuffers = function(){
    // In a real ATM PIN_buffer contains encrypted PIN, but in this application PIN_buffer contains clear PIN entered by cardholder.
    // To get the encrypted PIN, use getEncryptedPIN() method
    this.PIN_buffer = '';

    this.buffer_B = '';
    this.buffer_C = '';
    this.amount_buffer = '000000000000';
    this.opcode_buffer = '        ';
    this.FDK_buffer = '';   // FDK_buffer is only needed on state type W to determine the next state

    return true;
  }

  /**
   * [setScreen description]
   * @param {[type]} screen_number [description]
   */
  this.setScreen = function(screen_number){
    this.current_screen = this.screens.get(screen_number)
    if(this.current_screen){
      log.info('Screen changed to ' + this.current_screen.number);
    } else {
      log.error('atm.setScreen(): unable to find screen ' + screen_number);
    }
  }

  /**
   * [processStateA process the Card Read state]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processStateA = function(state){
    this.initBuffers();
    this.setScreen(state.screen_number)

    return state.good_read_next_state;
  }

  /**
   * [processPINEntryState description]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processPINEntryState = function(state){
    /**
     * The cardholder enters the PIN, which can consist of from four to
     * sixteen digits, on the facia keyboard. If the cardholder enters fewer
     * than the number of digits specified in the FIT entry, PMXPN, he
     * must press FDK ‘A’ (or FDK ‘I’, if the option which enables the keys
     * to the left of the CRT is set) or the Enter key after the last digit has
     * been entered. Pressing the Clear key clears all digits.
     */
    this.setScreen(state.screen_number)
    this.setFDKsActiveMask('001'); // Enabling button 'A' only
    this.max_pin_length = this.FITs.getMaxPINLength(this.card.number)

    if(this.PIN_buffer.length > 3){
      // TODO: PIN encryption
      return state.remote_pin_check_next_state
    }
  }

  /**
   * [processAmountEntryState description]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processAmountEntryState = function(state){
    log.info(this.trace.object(state));
    this.setScreen(state.screen_number);
    this.setFDKsActiveMask('015'); // Enabling 'A', 'B', 'C', 'D' buttons
    this.amount_buffer = '000000000000';

    var button = this.buttons_pressed.shift();
    if(this.isFDKButtonActive(button))
      return state['FDK_' + button + '_next_state'];
  }

  /**
   * [setOpCodeBufferValueAt set this.opcode_buffer[position] with the value ]
   * @param {[type]} position [description]
   * @param {[type]} value    [description]
   */
  this.setOpCodeBufferValueAt = function(position, value){
    this.opcode_buffer = this.opcode_buffer.substr(0, position) + value + this.opcode_buffer.substr(position + 1)
  }

  /**
   * [setOpCodeBuffer process the D state logic (Pre‐Set Operation Code Buffer)]
   * @param {[state]} state [D-type state]
   * @param {[extension_state]} state [Z-type state]
   */
  this.setOpCodeBuffer = function(state, extension_state){
    /**
     * Specifies bytes of Operation Code buffer to be cleared to graphic ‘space’. Each bit relates to a byte
     * in the Operation Code buffer. If a bit is zero, the corresponding entry is cleared. If a bit is one, the
     * corresponding entry is unchanged. 
     */
    var mask = state.clear_mask;
    for(var bit = 0; bit < 8; bit++){
      if((mask & Math.pow(2, bit)).toString() === '0')
        this.setOpCodeBufferValueAt(bit, ' ');
    }

    /**
     * The buffer contains eight bytes. This entry sets the specified bytes to one of the values from keys[]. If a bit is one, the
     * corresponding entry is set to keys[i]. If a bit is zero, the corresponding entry is unchanged.
     */
    var keys = ['A', 'B', 'C', 'D'];
    ['A_preset_mask',
     'B_preset_mask',
     'C_preset_mask',
     'D_preset_mask'
     ].forEach( (element, i) => {
        mask = state[element];
        for(var bit = 0; bit < 8; bit++){
          if((mask & Math.pow(2, bit)).toString() === Math.pow(2, bit).toString())
            this.setOpCodeBufferValueAt(bit, keys[i]);
        }
     });

    if(extension_state && extension_state.entries){
      var keys = [null, null, 'F', 'G', 'H', 'I'];
      for(var i = 2; i < 6; i++){
        mask = extension_state.entries[i];
        for(var bit = 0; bit < 8; bit++){
          if((mask & Math.pow(2, bit)).toString() === Math.pow(2, bit).toString())
            this.setOpCodeBufferValueAt(bit, keys[i]);
        }
       };
    }

    return true;
  }

  /**
   * [processStateD description]
   * @param  {[type]} state           [description]
   * @param  {[type]} extension_state [description]
   * @return {[type]}                 [description]
   */
  this.processStateD = function(state, extension_state){
    this.setOpCodeBuffer(state, extension_state);
    return state.next_state;
  }

  /**
   * [processFourFDKSelectionState description]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processFourFDKSelectionState = function(state){
    this.setScreen(state.screen_number);

    this.activeFDKs= [];
    ['A', 'B', 'C', 'D'].forEach((element, index) => {
      if(state['FDK_' + element + '_next_state'] !== '255')
        this.activeFDKs.push(element);
    })

    var button = this.buttons_pressed.shift();
    if(this.isFDKButtonActive(button)){
      var index = parseInt(state.buffer_location);
      if(index < 8)
        this.setOpCodeBufferValueAt(7 - index, button)
      else
        log.error('Invalid buffer location value: ' + state.buffer_location + '. Operation Code buffer is not changed');

      return state['FDK_' + button + '_next_state'];      
    }
  }


  /**
   * [processTransactionRequestState description]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processTransactionRequestState = function(state){
    this.setScreen(state.screen_number);

    var request = {
      message_class: 'Unsolicited',
      message_subclass: 'Transaction Request',
      top_of_receipt: '1',
      message_coordination_number: this.getMessageCoordinationNumber(),
    };

    if(state.send_track2 === '001')
      request.track2 = this.track2;

    // Send Track 1 and/or Track 3 option is not supported 

    if(state.send_operation_code === '001')
      request.opcode_buffer = this.opcode_buffer;

    if(state.send_amount_data === '001')
      request.amount_buffer = this.amount_buffer;

    switch(state.send_pin_buffer){
      case '001':   // Standard format. Send Buffer A
      case '129':   // Extended format. Send Buffer A
        request.PIN_buffer = this.getEncryptedPIN();
        break;
      case '000':   // Standard format. Do not send Buffer A
      case '128':   // Extended format. Do not send Buffer A
      default:
        break;
    }

    switch(state.send_buffer_B_buffer_C){
      case '000': // Send no buffers
        break;

      case '001': // Send Buffer B
        request.buffer_B = this.buffer_B;
        break;

      case '002': // Send Buffer C
        request.buffer_C = this.buffer_C;
        break;

      case '003': // Send Buffer B and C
        request.buffer_B = this.buffer_B;
        request.buffer_C = this.buffer_C;
        break;

      default:
        // TODO: If the extended format is selected in table entry 8, this entry is an Extension state number.
        if(state.send_pin_buffer in ['128', '129']){
          null;
        }
        break;
    }

    this.transaction_request = request; // further processing is performed by the atm listener
  }

  /**
   * [processCloseState description]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processCloseState = function(state){
    this.setScreen(state.receipt_delivered_screen);
  }

  /**
   * [processStateK description]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processStateK = function(state){
    var institution_id = this.FITs.getInstitutionByCardnumber(this.card.number)
    // log.info('Found institution_id ' + institution_id);
    return state.states_to[parseInt(institution_id)];
  }

  /**
   * [processStateW description]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processStateW = function(state){
    return state.states[this.FDK_buffer]
  }


  /**
   * [setAmountBuffer assign the provide value to amount buffer]
   * @param {[type]} amount [description]
   */
  this.setAmountBuffer = function(amount){
    if(!amount)
      return;
    this.amount_buffer = this.amount_buffer.substr(amount.length) + amount;
  };


  /**
   * [processStateX description]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processStateX = function(state, extension_state){
    this.setScreen(state.screen_number);
    this.setFDKsActiveMask(state.FDK_active_mask);

    var button = this.buttons_pressed.shift();
    if(this.isFDKButtonActive(button)){
      this.FDK_buffer = button;

      if(extension_state){
        /**
         * Each table entry contains a value that is stored in
         * the buffer specified in the associated FDK
         * Information Entry state table (table entry 7) if the
         * specified FDK or touch area is pressed.
         */
        var buffer_value;
        [null, null, 'A', 'B', 'C', 'D', 'F', 'G', 'H', 'I'].forEach((element, index) => {
          if(button === element)
            buffer_value = extension_state.entries[index];
        })

        /**
         * Buffer ID identifies which buffer is to be edited and the number of zeros to add 
         * to the values specified in the Extension state:
         * 01X - General purpose buffer B
         * 02X - General purpose buffer C
         * 03X - Amount buffer
         * X specifies the number of zeros in the range 0-9
         */
        // Checking number of zeores to pad
        var num_of_zeroes = state.buffer_id.substr(2, 1);
        for (var i = 0; i < num_of_zeroes; i++)
          buffer_value += '0';

        // Checking which buffer to use
        switch(state.buffer_id.substr(1, 1)){
          case '1':
            this.buffer_B = buffer_value;
            break;
  
          case '2':
            this.buffer_C = buffer_value;
            break;
  
          case '3':
            this.setAmountBuffer(buffer_value);
            break;
  
          default:
            log.error('Unsupported buffer id value: ' + state.buffer_id);
            break;
        }
      }

      return state.FDK_next_state;
    }
  }

  /**
   * [processStateY description]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processStateY = function(state){
    log.info(this.trace.object(state));
    this.setScreen(state.screen_number);
    this.setFDKsActiveMask(state.FDK_active_mask);

    var button = this.buttons_pressed.shift();
    if(this.isFDKButtonActive(button)){
      this.FDK_buffer = button;
      return state.FDK_next_state;
    }
  }

  /**
   * [processStateBeginICCInit description]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processStateBeginICCInit = function(state){
    return state.icc_init_not_started_next_state;
  }

  /**
   * [processStateCompleteICCAppInit description]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processStateCompleteICCAppInit = function(state){
    var extension_state = this.states.get(state.extension_state);
    this.setScreen(state.please_wait_screen_number);

    log.info(this.trace.object(extension_state))
    return extension_state.entries[8]; // Processing not performed
  }

  /**
   * [processICCReinit description]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processICCReinit = function(state){
    return state.processing_not_performed_next_state;
  }


  /**
   * [processSetICCDataState description]
   * @param  {[type]} state [description]
   * @return {[type]}       [description]
   */
  this.processSetICCDataState = function(state){
    // No processing as ICC cards are not currently supported
    return state.next_state;
  }


  /**
   * [processState description]
   * @param  {[type]} state_number [description]
   * @return {[type]}              [description]
   */
  this.processState = function(state_number){
    var state = this.states.get(state_number);
    var next_state = null;

    do{
      if(state){
        this.current_state = state;
        log.info('Processing state ' + state.number + state.type + ' (' + state.description + ')');
      }else
      {
        log.error('Error getting state ' + state_number + ': state not found');
        return false;
      }
        
      switch(state.type){
        case 'A':
          next_state = this.processStateA(state);
          break;

        case 'B':
          next_state = this.processPINEntryState(state);
          break;

        case 'D':
          state.extension_state !== '255' ? next_state = this.processStateD(state, this.states.get(state.extension_state)) : next_state = this.processStateD(state);
          break;

        case 'E':
          next_state = this.processFourFDKSelectionState(state);
          break;

        case 'F':
          next_state = this.processAmountEntryState(state);
          break;

        case 'I':
          next_state = this.processTransactionRequestState(state);
          break;

        case 'J':
          next_state = this.processCloseState(state);
          break;

        case 'K':
          next_state = this.processStateK(state);
          break;

        case 'X':
          (state.extension_state !== '255' && state.extension_state !== '000') ? next_state = this.processStateX(state, this.states.get(state.extension_state)) : next_state = this.processStateX(state);
          break;

        case 'Y':
          next_state = this.processStateY(state);
          break;

        case 'W':
          next_state = this.processStateW(state);
          break;

        case '+':
          next_state = this.processStateBeginICCInit(state);
          break;

        case '/':
          next_state = this.processStateCompleteICCAppInit(state);
          break;

        case ';':
          next_state = this.processICCReinit(state);
          break;

        case '?':
          next_state = this.processSetICCDataState(state);
          break;

        default:
          log.error('atm.processState(): unsupported state type ' + state.type);
          next_state = null;
      }

      if(next_state)
        state = this.states.get(next_state);
      else
        break;

    }while(state);

    return true;
  }

  /**
   * [parseTrack2 parse track2 and return card object]
   * @param  {[type]} track2 [track2 string]
   * @return {[card object]} [description]
   */
  this.parseTrack2 = function(track2){
    var card = {};
    try{
      var splitted = track2.split('=')
      card.track2 = track2;
      card.number = splitted[0].replace(';', '');
      card.service_code = splitted[1].substr(4, 3);
    }catch(e){
      log.info(e);
      return null;
    }

    return card;
  }

  this.readCard = function(cardnumber, track2_data){
    this.track2 = cardnumber + '=' + track2_data;
    this.card = this.parseTrack2(this.track2)
    if(this.card){
      log.info('Card ' + this.card.number + ' read');
      this.processState('000');
    }
  }

  this.trace = new Trace();
  this.states = new StatesService(settings, log);
  this.screens = new ScreensService(settings, log);
  this.FITs = new FITsService(settings, log);
  this.pinblock = new Pinblock();
  this.des3 = new DES3();

  this.status = 'Offline';
  this.initBuffers();
  this.current_screen = {};
  this.current_state = {};
  this.buttons_pressed = [];
  this.activeFDKs = [];
  this.transaction_request = null;
}

/**
 * [processFDKButtonPressed description]
 * @param  {[type]} button [description]
 * @return {[type]}        [description]
 */
ATM.prototype.processFDKButtonPressed = function(button){
  log.info(button + ' button pressed');

  switch(this.current_state.type){
    case 'B':
      if (button === 'A' && this.PIN_buffer.length >= 4)
        this.processState(this.current_state.number);
      break;

    default:
      // No special processing required
      this.buttons_pressed.push(button);
      this.processState(this.current_state.number);
      break;
  };
};


/**
 * [processPinpadButtonPressed description]
 * @param  {[type]} button [description]
 * @return {[type]}        [description]
 */
ATM.prototype.processPinpadButtonPressed = function(button){
  //log.info('Button ' + button + ' pressed');
  switch(this.current_state.type){
    case 'B':
      switch(button){
        case 'backspace':
          this.PIN_buffer = this.PIN_buffer.slice(0, -1);
          break;

        case 'enter':
          if(this.PIN_buffer.length >= 4)
            this.processState(this.current_state.number)
          break;

        default:
          this.PIN_buffer += button;
          //log.info(this.PIN_buffer);
          if(this.PIN_buffer.length == this.max_pin_length)
            this.processState(this.current_state.number)
      }
      break;

    case 'F':
      switch(button){
        case 'enter':
          // If the cardholder presses the Enter key, it has the same effect as pressing FDK ‘A’
          this.buttons_pressed.push('A');
          this.processState(this.current_state.number)
          break;

        case 'backspace':
          this.amount_buffer = '0' + this.amount_buffer.substr(0, this.amount_buffer.length - 1)
          break;

        default:
          this.amount_buffer = this.amount_buffer.substr(1) + button;
          break;
      }
      break;

    default:
      log.error('No keyboard entry allowed for state type ' + this.current_state.type);
      break;
  }
};

/**
 * [processHostMessage description]
 * @param  {[type]} data [description]
 * @return {[type]}      [description]
 */
ATM.prototype.processHostMessage = function(data){
  switch(data.message_class){
    case 'Terminal Command':
      return this.processTerminalCommand(data);

    case 'Data Command':
      return this.processDataCommand(data);

    case 'Transaction Reply Command':
      return this.processTransactionReply(data);
            
    default:
      log.info('ATM.processHostMessage(): unknown message class: ' + data.message_class);
      break;
  }
  return false;
};

module.exports = ATM;
