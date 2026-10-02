/* global window, document, fetch, navigator, setTimeout, clearTimeout, setInterval, clearInterval */
// plugin/client.js — 设置 → VPS 部署
//
// 手写单文件 bundle，没有构建链：供 DSH web 客户端的 ModuleLoader 注入。
// 只挂一处：settings.section。
//
// 两种状态，由同源的 /gate/update 能否返回网关数据来判断：
//   - 这个 DSH 是 dsh-vps 部署的（前面有 dsh-gate）：DSH 版本与一键升级、网关状态、服务器常用命令
//   - 普通 DSH：把 DSH 部署到自己 VPS 的一键命令
//
// 升级请求由网关校验登录与同源后写入请求文件，真正执行的是服务器上 root 的
// dsh-vps-upgrade 服务（备份 → 安装 → 自检 → 失败自动回滚）；页面只负责发起与展示。
//
// 硬约束：界面出错不能影响 DSH 本身，注册一律包在 try/catch 里。

window.__ModuleLoader__.load({
  id: 'dsh-vps',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    // ——————————————————————— 二维码（内嵌第三方库） ———————————————————————
    // qrcode-generator 2.0.4 · Copyright (c) 2009 Kazuhiko Arase · MIT License
    // https://github.com/kazuhikoarase/qrcode-generator —— 原样内嵌（去掉末尾的 UMD 导出包装），
    // 本地生成二维码，不依赖任何外部服务。
    //---------------------------------------------------------------------
    //
    // QR Code Generator for JavaScript
    //
    // Copyright (c) 2009 Kazuhiko Arase
    //
    // URL: http://www.d-project.com/
    //
    // Licensed under the MIT license:
    //  http://www.opensource.org/licenses/mit-license.php
    //
    // The word 'QR Code' is registered trademark of
    // DENSO WAVE INCORPORATED
    //  http://www.denso-wave.com/qrcode/faqpatent-e.html
    //
    //---------------------------------------------------------------------

    var qrcode = function() {

      //---------------------------------------------------------------------
      // qrcode
      //---------------------------------------------------------------------

      /**
       * qrcode
       * @param typeNumber 1 to 40
       * @param errorCorrectionLevel 'L','M','Q','H'
       */
      var qrcode = function(typeNumber, errorCorrectionLevel) {

        var PAD0 = 0xEC;
        var PAD1 = 0x11;

        var _typeNumber = typeNumber;
        var _errorCorrectionLevel = QRErrorCorrectionLevel[errorCorrectionLevel];
        var _modules = null;
        var _moduleCount = 0;
        var _dataCache = null;
        var _dataList = [];

        var _this = {};

        var makeImpl = function(test, maskPattern) {

          _moduleCount = _typeNumber * 4 + 17;
          _modules = function(moduleCount) {
            var modules = new Array(moduleCount);
            for (var row = 0; row < moduleCount; row += 1) {
              modules[row] = new Array(moduleCount);
              for (var col = 0; col < moduleCount; col += 1) {
                modules[row][col] = null;
              }
            }
            return modules;
          }(_moduleCount);

          setupPositionProbePattern(0, 0);
          setupPositionProbePattern(_moduleCount - 7, 0);
          setupPositionProbePattern(0, _moduleCount - 7);
          setupPositionAdjustPattern();
          setupTimingPattern();
          setupTypeInfo(test, maskPattern);

          if (_typeNumber >= 7) {
            setupTypeNumber(test);
          }

          if (_dataCache == null) {
            _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList);
          }

          mapData(_dataCache, maskPattern);
        };

        var setupPositionProbePattern = function(row, col) {

          for (var r = -1; r <= 7; r += 1) {

            if (row + r <= -1 || _moduleCount <= row + r) continue;

            for (var c = -1; c <= 7; c += 1) {

              if (col + c <= -1 || _moduleCount <= col + c) continue;

              if ( (0 <= r && r <= 6 && (c == 0 || c == 6) )
                  || (0 <= c && c <= 6 && (r == 0 || r == 6) )
                  || (2 <= r && r <= 4 && 2 <= c && c <= 4) ) {
                _modules[row + r][col + c] = true;
              } else {
                _modules[row + r][col + c] = false;
              }
            }
          }
        };

        var getBestMaskPattern = function() {

          var minLostPoint = 0;
          var pattern = 0;

          for (var i = 0; i < 8; i += 1) {

            makeImpl(true, i);

            var lostPoint = QRUtil.getLostPoint(_this);

            if (i == 0 || minLostPoint > lostPoint) {
              minLostPoint = lostPoint;
              pattern = i;
            }
          }

          return pattern;
        };

        var setupTimingPattern = function() {

          for (var r = 8; r < _moduleCount - 8; r += 1) {
            if (_modules[r][6] != null) {
              continue;
            }
            _modules[r][6] = (r % 2 == 0);
          }

          for (var c = 8; c < _moduleCount - 8; c += 1) {
            if (_modules[6][c] != null) {
              continue;
            }
            _modules[6][c] = (c % 2 == 0);
          }
        };

        var setupPositionAdjustPattern = function() {

          var pos = QRUtil.getPatternPosition(_typeNumber);

          for (var i = 0; i < pos.length; i += 1) {

            for (var j = 0; j < pos.length; j += 1) {

              var row = pos[i];
              var col = pos[j];

              if (_modules[row][col] != null) {
                continue;
              }

              for (var r = -2; r <= 2; r += 1) {

                for (var c = -2; c <= 2; c += 1) {

                  if (r == -2 || r == 2 || c == -2 || c == 2
                      || (r == 0 && c == 0) ) {
                    _modules[row + r][col + c] = true;
                  } else {
                    _modules[row + r][col + c] = false;
                  }
                }
              }
            }
          }
        };

        var setupTypeNumber = function(test) {

          var bits = QRUtil.getBCHTypeNumber(_typeNumber);

          for (var i = 0; i < 18; i += 1) {
            var mod = (!test && ( (bits >> i) & 1) == 1);
            _modules[Math.floor(i / 3)][i % 3 + _moduleCount - 8 - 3] = mod;
          }

          for (var i = 0; i < 18; i += 1) {
            var mod = (!test && ( (bits >> i) & 1) == 1);
            _modules[i % 3 + _moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
          }
        };

        var setupTypeInfo = function(test, maskPattern) {

          var data = (_errorCorrectionLevel << 3) | maskPattern;
          var bits = QRUtil.getBCHTypeInfo(data);

          // vertical
          for (var i = 0; i < 15; i += 1) {

            var mod = (!test && ( (bits >> i) & 1) == 1);

            if (i < 6) {
              _modules[i][8] = mod;
            } else if (i < 8) {
              _modules[i + 1][8] = mod;
            } else {
              _modules[_moduleCount - 15 + i][8] = mod;
            }
          }

          // horizontal
          for (var i = 0; i < 15; i += 1) {

            var mod = (!test && ( (bits >> i) & 1) == 1);

            if (i < 8) {
              _modules[8][_moduleCount - i - 1] = mod;
            } else if (i < 9) {
              _modules[8][15 - i - 1 + 1] = mod;
            } else {
              _modules[8][15 - i - 1] = mod;
            }
          }

          // fixed module
          _modules[_moduleCount - 8][8] = (!test);
        };

        var mapData = function(data, maskPattern) {

          var inc = -1;
          var row = _moduleCount - 1;
          var bitIndex = 7;
          var byteIndex = 0;
          var maskFunc = QRUtil.getMaskFunction(maskPattern);

          for (var col = _moduleCount - 1; col > 0; col -= 2) {

            if (col == 6) col -= 1;

            while (true) {

              for (var c = 0; c < 2; c += 1) {

                if (_modules[row][col - c] == null) {

                  var dark = false;

                  if (byteIndex < data.length) {
                    dark = ( ( (data[byteIndex] >>> bitIndex) & 1) == 1);
                  }

                  var mask = maskFunc(row, col - c);

                  if (mask) {
                    dark = !dark;
                  }

                  _modules[row][col - c] = dark;
                  bitIndex -= 1;

                  if (bitIndex == -1) {
                    byteIndex += 1;
                    bitIndex = 7;
                  }
                }
              }

              row += inc;

              if (row < 0 || _moduleCount <= row) {
                row -= inc;
                inc = -inc;
                break;
              }
            }
          }
        };

        var createBytes = function(buffer, rsBlocks) {

          var offset = 0;

          var maxDcCount = 0;
          var maxEcCount = 0;

          var dcdata = new Array(rsBlocks.length);
          var ecdata = new Array(rsBlocks.length);

          for (var r = 0; r < rsBlocks.length; r += 1) {

            var dcCount = rsBlocks[r].dataCount;
            var ecCount = rsBlocks[r].totalCount - dcCount;

            maxDcCount = Math.max(maxDcCount, dcCount);
            maxEcCount = Math.max(maxEcCount, ecCount);

            dcdata[r] = new Array(dcCount);

            for (var i = 0; i < dcdata[r].length; i += 1) {
              dcdata[r][i] = 0xff & buffer.getBuffer()[i + offset];
            }
            offset += dcCount;

            var rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
            var rawPoly = qrPolynomial(dcdata[r], rsPoly.getLength() - 1);

            var modPoly = rawPoly.mod(rsPoly);
            ecdata[r] = new Array(rsPoly.getLength() - 1);
            for (var i = 0; i < ecdata[r].length; i += 1) {
              var modIndex = i + modPoly.getLength() - ecdata[r].length;
              ecdata[r][i] = (modIndex >= 0)? modPoly.getAt(modIndex) : 0;
            }
          }

          var totalCodeCount = 0;
          for (var i = 0; i < rsBlocks.length; i += 1) {
            totalCodeCount += rsBlocks[i].totalCount;
          }

          var data = new Array(totalCodeCount);
          var index = 0;

          for (var i = 0; i < maxDcCount; i += 1) {
            for (var r = 0; r < rsBlocks.length; r += 1) {
              if (i < dcdata[r].length) {
                data[index] = dcdata[r][i];
                index += 1;
              }
            }
          }

          for (var i = 0; i < maxEcCount; i += 1) {
            for (var r = 0; r < rsBlocks.length; r += 1) {
              if (i < ecdata[r].length) {
                data[index] = ecdata[r][i];
                index += 1;
              }
            }
          }

          return data;
        };

        var createData = function(typeNumber, errorCorrectionLevel, dataList) {

          var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectionLevel);

          var buffer = qrBitBuffer();

          for (var i = 0; i < dataList.length; i += 1) {
            var data = dataList[i];
            buffer.put(data.getMode(), 4);
            buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
            data.write(buffer);
          }

          // calc num max data.
          var totalDataCount = 0;
          for (var i = 0; i < rsBlocks.length; i += 1) {
            totalDataCount += rsBlocks[i].dataCount;
          }

          if (buffer.getLengthInBits() > totalDataCount * 8) {
            throw 'code length overflow. ('
              + buffer.getLengthInBits()
              + '>'
              + totalDataCount * 8
              + ')';
          }

          // end code
          if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {
            buffer.put(0, 4);
          }

          // padding
          while (buffer.getLengthInBits() % 8 != 0) {
            buffer.putBit(false);
          }

          // padding
          while (true) {

            if (buffer.getLengthInBits() >= totalDataCount * 8) {
              break;
            }
            buffer.put(PAD0, 8);

            if (buffer.getLengthInBits() >= totalDataCount * 8) {
              break;
            }
            buffer.put(PAD1, 8);
          }

          return createBytes(buffer, rsBlocks);
        };

        _this.addData = function(data, mode) {

          mode = mode || 'Byte';

          var newData = null;

          switch(mode) {
          case 'Numeric' :
            newData = qrNumber(data);
            break;
          case 'Alphanumeric' :
            newData = qrAlphaNum(data);
            break;
          case 'Byte' :
            newData = qr8BitByte(data);
            break;
          case 'Kanji' :
            newData = qrKanji(data);
            break;
          default :
            throw 'mode:' + mode;
          }

          _dataList.push(newData);
          _dataCache = null;
        };

        _this.isDark = function(row, col) {
          if (row < 0 || _moduleCount <= row || col < 0 || _moduleCount <= col) {
            throw row + ',' + col;
          }
          return _modules[row][col];
        };

        _this.getModuleCount = function() {
          return _moduleCount;
        };

        _this.make = function() {
          if (_typeNumber < 1) {
            var typeNumber = 1;

            for (; typeNumber < 40; typeNumber++) {
              var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, _errorCorrectionLevel);
              var buffer = qrBitBuffer();

              for (var i = 0; i < _dataList.length; i++) {
                var data = _dataList[i];
                buffer.put(data.getMode(), 4);
                buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
                data.write(buffer);
              }

              var totalDataCount = 0;
              for (var i = 0; i < rsBlocks.length; i++) {
                totalDataCount += rsBlocks[i].dataCount;
              }

              if (buffer.getLengthInBits() <= totalDataCount * 8) {
                break;
              }
            }

            _typeNumber = typeNumber;
          }

          makeImpl(false, getBestMaskPattern() );
        };

        _this.createTableTag = function(cellSize, margin) {

          cellSize = cellSize || 2;
          margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

          var qrHtml = '';

          qrHtml += '<table style="';
          qrHtml += ' border-width: 0px; border-style: none;';
          qrHtml += ' border-collapse: collapse;';
          qrHtml += ' padding: 0px; margin: ' + margin + 'px;';
          qrHtml += '">';
          qrHtml += '<tbody>';

          for (var r = 0; r < _this.getModuleCount(); r += 1) {

            qrHtml += '<tr>';

            for (var c = 0; c < _this.getModuleCount(); c += 1) {
              qrHtml += '<td style="';
              qrHtml += ' border-width: 0px; border-style: none;';
              qrHtml += ' border-collapse: collapse;';
              qrHtml += ' padding: 0px; margin: 0px;';
              qrHtml += ' width: ' + cellSize + 'px;';
              qrHtml += ' height: ' + cellSize + 'px;';
              qrHtml += ' background-color: ';
              qrHtml += _this.isDark(r, c)? '#000000' : '#ffffff';
              qrHtml += ';';
              qrHtml += '"/>';
            }

            qrHtml += '</tr>';
          }

          qrHtml += '</tbody>';
          qrHtml += '</table>';

          return qrHtml;
        };

        _this.createSvgTag = function(cellSize, margin, alt, title) {

          var opts = {};
          if (typeof arguments[0] == 'object') {
            // Called by options.
            opts = arguments[0];
            // overwrite cellSize and margin.
            cellSize = opts.cellSize;
            margin = opts.margin;
            alt = opts.alt;
            title = opts.title;
          }

          cellSize = cellSize || 2;
          margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

          // Compose alt property surrogate
          alt = (typeof alt === 'string') ? {text: alt} : alt || {};
          alt.text = alt.text || null;
          alt.id = (alt.text) ? alt.id || 'qrcode-description' : null;

          // Compose title property surrogate
          title = (typeof title === 'string') ? {text: title} : title || {};
          title.text = title.text || null;
          title.id = (title.text) ? title.id || 'qrcode-title' : null;

          var size = _this.getModuleCount() * cellSize + margin * 2;
          var c, mc, r, mr, qrSvg='', rect;

          rect = 'l' + cellSize + ',0 0,' + cellSize +
            ' -' + cellSize + ',0 0,-' + cellSize + 'z ';

          qrSvg += '<svg version="1.1" xmlns="http://www.w3.org/2000/svg"';
          qrSvg += !opts.scalable ? ' width="' + size + 'px" height="' + size + 'px"' : '';
          qrSvg += ' viewBox="0 0 ' + size + ' ' + size + '" ';
          qrSvg += ' preserveAspectRatio="xMinYMin meet"';
          qrSvg += (title.text || alt.text) ? ' role="img" aria-labelledby="' +
              escapeXml([title.id, alt.id].join(' ').trim() ) + '"' : '';
          qrSvg += '>';
          qrSvg += (title.text) ? '<title id="' + escapeXml(title.id) + '">' +
              escapeXml(title.text) + '</title>' : '';
          qrSvg += (alt.text) ? '<description id="' + escapeXml(alt.id) + '">' +
              escapeXml(alt.text) + '</description>' : '';
          qrSvg += '<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>';
          qrSvg += '<path d="';

          for (r = 0; r < _this.getModuleCount(); r += 1) {
            mr = r * cellSize + margin;
            for (c = 0; c < _this.getModuleCount(); c += 1) {
              if (_this.isDark(r, c) ) {
                mc = c*cellSize+margin;
                qrSvg += 'M' + mc + ',' + mr + rect;
              }
            }
          }

          qrSvg += '" stroke="transparent" fill="black"/>';
          qrSvg += '</svg>';

          return qrSvg;
        };

        _this.createDataURL = function(cellSize, margin) {

          cellSize = cellSize || 2;
          margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

          var size = _this.getModuleCount() * cellSize + margin * 2;
          var min = margin;
          var max = size - margin;

          return createDataURL(size, size, function(x, y) {
            if (min <= x && x < max && min <= y && y < max) {
              var c = Math.floor( (x - min) / cellSize);
              var r = Math.floor( (y - min) / cellSize);
              return _this.isDark(r, c)? 0 : 1;
            } else {
              return 1;
            }
          } );
        };

        _this.createImgTag = function(cellSize, margin, alt) {

          cellSize = cellSize || 2;
          margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

          var size = _this.getModuleCount() * cellSize + margin * 2;

          var img = '';
          img += '<img';
          img += '\u0020src="';
          img += _this.createDataURL(cellSize, margin);
          img += '"';
          img += '\u0020width="';
          img += size;
          img += '"';
          img += '\u0020height="';
          img += size;
          img += '"';
          if (alt) {
            img += '\u0020alt="';
            img += escapeXml(alt);
            img += '"';
          }
          img += '/>';

          return img;
        };

        var escapeXml = function(s) {
          var escaped = '';
          for (var i = 0; i < s.length; i += 1) {
            var c = s.charAt(i);
            switch(c) {
            case '<': escaped += '&lt;'; break;
            case '>': escaped += '&gt;'; break;
            case '&': escaped += '&amp;'; break;
            case '"': escaped += '&quot;'; break;
            default : escaped += c; break;
            }
          }
          return escaped;
        };

        var _createHalfASCII = function(margin) {
          var cellSize = 1;
          margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

          var size = _this.getModuleCount() * cellSize + margin * 2;
          var min = margin;
          var max = size - margin;

          var y, x, r1, r2, p;

          var blocks = {
            '██': '█',
            '█ ': '▀',
            ' █': '▄',
            '  ': ' '
          };

          var blocksLastLineNoMargin = {
            '██': '▀',
            '█ ': '▀',
            ' █': ' ',
            '  ': ' '
          };

          var ascii = '';
          for (y = 0; y < size; y += 2) {
            r1 = Math.floor((y - min) / cellSize);
            r2 = Math.floor((y + 1 - min) / cellSize);
            for (x = 0; x < size; x += 1) {
              p = '█';

              if (min <= x && x < max && min <= y && y < max && _this.isDark(r1, Math.floor((x - min) / cellSize))) {
                p = ' ';
              }

              if (min <= x && x < max && min <= y+1 && y+1 < max && _this.isDark(r2, Math.floor((x - min) / cellSize))) {
                p += ' ';
              }
              else {
                p += '█';
              }

              // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
              ascii += (margin < 1 && y+1 >= max) ? blocksLastLineNoMargin[p] : blocks[p];
            }

            ascii += '\n';
          }

          if (size % 2 && margin > 0) {
            return ascii.substring(0, ascii.length - size - 1) + Array(size+1).join('▀');
          }

          return ascii.substring(0, ascii.length-1);
        };

        _this.createASCII = function(cellSize, margin) {
          cellSize = cellSize || 1;

          if (cellSize < 2) {
            return _createHalfASCII(margin);
          }

          cellSize -= 1;
          margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

          var size = _this.getModuleCount() * cellSize + margin * 2;
          var min = margin;
          var max = size - margin;

          var y, x, r, p;

          var white = Array(cellSize+1).join('██');
          var black = Array(cellSize+1).join('  ');

          var ascii = '';
          var line = '';
          for (y = 0; y < size; y += 1) {
            r = Math.floor( (y - min) / cellSize);
            line = '';
            for (x = 0; x < size; x += 1) {
              p = 1;

              if (min <= x && x < max && min <= y && y < max && _this.isDark(r, Math.floor((x - min) / cellSize))) {
                p = 0;
              }

              // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
              line += p ? white : black;
            }

            for (r = 0; r < cellSize; r += 1) {
              ascii += line + '\n';
            }
          }

          return ascii.substring(0, ascii.length-1);
        };

        _this.renderTo2dContext = function(context, cellSize) {
          cellSize = cellSize || 2;
          var length = _this.getModuleCount();
          for (var row = 0; row < length; row++) {
            for (var col = 0; col < length; col++) {
              context.fillStyle = _this.isDark(row, col) ? 'black' : 'white';
              context.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
            }
          }
        }

        return _this;
      };

      //---------------------------------------------------------------------
      // qrcode.stringToBytes
      //---------------------------------------------------------------------

      qrcode.stringToBytesFuncs = {
        'default' : function(s) {
          var bytes = [];
          for (var i = 0; i < s.length; i += 1) {
            var c = s.charCodeAt(i);
            bytes.push(c & 0xff);
          }
          return bytes;
        }
      };

      qrcode.stringToBytes = qrcode.stringToBytesFuncs['default'];

      //---------------------------------------------------------------------
      // qrcode.createStringToBytes
      //---------------------------------------------------------------------

      /**
       * @param unicodeData base64 string of byte array.
       * [16bit Unicode],[16bit Bytes], ...
       * @param numChars
       */
      qrcode.createStringToBytes = function(unicodeData, numChars) {

        // create conversion map.

        var unicodeMap = function() {

          var bin = base64DecodeInputStream(unicodeData);
          var read = function() {
            var b = bin.read();
            if (b == -1) throw 'eof';
            return b;
          };

          var count = 0;
          var unicodeMap = {};
          while (true) {
            var b0 = bin.read();
            if (b0 == -1) break;
            var b1 = read();
            var b2 = read();
            var b3 = read();
            var k = String.fromCharCode( (b0 << 8) | b1);
            var v = (b2 << 8) | b3;
            unicodeMap[k] = v;
            count += 1;
          }
          if (count != numChars) {
            throw count + ' != ' + numChars;
          }

          return unicodeMap;
        }();

        var unknownChar = '?'.charCodeAt(0);

        return function(s) {
          var bytes = [];
          for (var i = 0; i < s.length; i += 1) {
            var c = s.charCodeAt(i);
            if (c < 128) {
              bytes.push(c);
            } else {
              var b = unicodeMap[s.charAt(i)];
              if (typeof b == 'number') {
                if ( (b & 0xff) == b) {
                  // 1byte
                  bytes.push(b);
                } else {
                  // 2bytes
                  bytes.push(b >>> 8);
                  bytes.push(b & 0xff);
                }
              } else {
                bytes.push(unknownChar);
              }
            }
          }
          return bytes;
        };
      };

      //---------------------------------------------------------------------
      // QRMode
      //---------------------------------------------------------------------

      var QRMode = {
        MODE_NUMBER :    1 << 0,
        MODE_ALPHA_NUM : 1 << 1,
        MODE_8BIT_BYTE : 1 << 2,
        MODE_KANJI :     1 << 3
      };

      //---------------------------------------------------------------------
      // QRErrorCorrectionLevel
      //---------------------------------------------------------------------

      var QRErrorCorrectionLevel = {
        L : 1,
        M : 0,
        Q : 3,
        H : 2
      };

      //---------------------------------------------------------------------
      // QRMaskPattern
      //---------------------------------------------------------------------

      var QRMaskPattern = {
        PATTERN000 : 0,
        PATTERN001 : 1,
        PATTERN010 : 2,
        PATTERN011 : 3,
        PATTERN100 : 4,
        PATTERN101 : 5,
        PATTERN110 : 6,
        PATTERN111 : 7
      };

      //---------------------------------------------------------------------
      // QRUtil
      //---------------------------------------------------------------------

      var QRUtil = function() {

        var PATTERN_POSITION_TABLE = [
          [],
          [6, 18],
          [6, 22],
          [6, 26],
          [6, 30],
          [6, 34],
          [6, 22, 38],
          [6, 24, 42],
          [6, 26, 46],
          [6, 28, 50],
          [6, 30, 54],
          [6, 32, 58],
          [6, 34, 62],
          [6, 26, 46, 66],
          [6, 26, 48, 70],
          [6, 26, 50, 74],
          [6, 30, 54, 78],
          [6, 30, 56, 82],
          [6, 30, 58, 86],
          [6, 34, 62, 90],
          [6, 28, 50, 72, 94],
          [6, 26, 50, 74, 98],
          [6, 30, 54, 78, 102],
          [6, 28, 54, 80, 106],
          [6, 32, 58, 84, 110],
          [6, 30, 58, 86, 114],
          [6, 34, 62, 90, 118],
          [6, 26, 50, 74, 98, 122],
          [6, 30, 54, 78, 102, 126],
          [6, 26, 52, 78, 104, 130],
          [6, 30, 56, 82, 108, 134],
          [6, 34, 60, 86, 112, 138],
          [6, 30, 58, 86, 114, 142],
          [6, 34, 62, 90, 118, 146],
          [6, 30, 54, 78, 102, 126, 150],
          [6, 24, 50, 76, 102, 128, 154],
          [6, 28, 54, 80, 106, 132, 158],
          [6, 32, 58, 84, 110, 136, 162],
          [6, 26, 54, 82, 110, 138, 166],
          [6, 30, 58, 86, 114, 142, 170]
        ];
        var G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
        var G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);
        var G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);

        var _this = {};

        var getBCHDigit = function(data) {
          var digit = 0;
          while (data != 0) {
            digit += 1;
            data >>>= 1;
          }
          return digit;
        };

        _this.getBCHTypeInfo = function(data) {
          var d = data << 10;
          while (getBCHDigit(d) - getBCHDigit(G15) >= 0) {
            d ^= (G15 << (getBCHDigit(d) - getBCHDigit(G15) ) );
          }
          return ( (data << 10) | d) ^ G15_MASK;
        };

        _this.getBCHTypeNumber = function(data) {
          var d = data << 12;
          while (getBCHDigit(d) - getBCHDigit(G18) >= 0) {
            d ^= (G18 << (getBCHDigit(d) - getBCHDigit(G18) ) );
          }
          return (data << 12) | d;
        };

        _this.getPatternPosition = function(typeNumber) {
          return PATTERN_POSITION_TABLE[typeNumber - 1];
        };

        _this.getMaskFunction = function(maskPattern) {

          switch (maskPattern) {

          case QRMaskPattern.PATTERN000 :
            return function(i, j) { return (i + j) % 2 == 0; };
          case QRMaskPattern.PATTERN001 :
            return function(i, j) { return i % 2 == 0; };
          case QRMaskPattern.PATTERN010 :
            return function(i, j) { return j % 3 == 0; };
          case QRMaskPattern.PATTERN011 :
            return function(i, j) { return (i + j) % 3 == 0; };
          case QRMaskPattern.PATTERN100 :
            return function(i, j) { return (Math.floor(i / 2) + Math.floor(j / 3) ) % 2 == 0; };
          case QRMaskPattern.PATTERN101 :
            return function(i, j) { return (i * j) % 2 + (i * j) % 3 == 0; };
          case QRMaskPattern.PATTERN110 :
            return function(i, j) { return ( (i * j) % 2 + (i * j) % 3) % 2 == 0; };
          case QRMaskPattern.PATTERN111 :
            return function(i, j) { return ( (i * j) % 3 + (i + j) % 2) % 2 == 0; };

          default :
            throw 'bad maskPattern:' + maskPattern;
          }
        };

        _this.getErrorCorrectPolynomial = function(errorCorrectLength) {
          var a = qrPolynomial([1], 0);
          for (var i = 0; i < errorCorrectLength; i += 1) {
            a = a.multiply(qrPolynomial([1, QRMath.gexp(i)], 0) );
          }
          return a;
        };

        _this.getLengthInBits = function(mode, type) {

          if (1 <= type && type < 10) {

            // 1 - 9

            switch(mode) {
            case QRMode.MODE_NUMBER    : return 10;
            case QRMode.MODE_ALPHA_NUM : return 9;
            case QRMode.MODE_8BIT_BYTE : return 8;
            case QRMode.MODE_KANJI     : return 8;
            default :
              throw 'mode:' + mode;
            }

          } else if (type < 27) {

            // 10 - 26

            switch(mode) {
            case QRMode.MODE_NUMBER    : return 12;
            case QRMode.MODE_ALPHA_NUM : return 11;
            case QRMode.MODE_8BIT_BYTE : return 16;
            case QRMode.MODE_KANJI     : return 10;
            default :
              throw 'mode:' + mode;
            }

          } else if (type < 41) {

            // 27 - 40

            switch(mode) {
            case QRMode.MODE_NUMBER    : return 14;
            case QRMode.MODE_ALPHA_NUM : return 13;
            case QRMode.MODE_8BIT_BYTE : return 16;
            case QRMode.MODE_KANJI     : return 12;
            default :
              throw 'mode:' + mode;
            }

          } else {
            throw 'type:' + type;
          }
        };

        _this.getLostPoint = function(qrcode) {

          var moduleCount = qrcode.getModuleCount();

          var lostPoint = 0;

          // LEVEL1

          for (var row = 0; row < moduleCount; row += 1) {
            for (var col = 0; col < moduleCount; col += 1) {

              var sameCount = 0;
              var dark = qrcode.isDark(row, col);

              for (var r = -1; r <= 1; r += 1) {

                if (row + r < 0 || moduleCount <= row + r) {
                  continue;
                }

                for (var c = -1; c <= 1; c += 1) {

                  if (col + c < 0 || moduleCount <= col + c) {
                    continue;
                  }

                  if (r == 0 && c == 0) {
                    continue;
                  }

                  if (dark == qrcode.isDark(row + r, col + c) ) {
                    sameCount += 1;
                  }
                }
              }

              if (sameCount > 5) {
                lostPoint += (3 + sameCount - 5);
              }
            }
          };

          // LEVEL2

          for (var row = 0; row < moduleCount - 1; row += 1) {
            for (var col = 0; col < moduleCount - 1; col += 1) {
              var count = 0;
              if (qrcode.isDark(row, col) ) count += 1;
              if (qrcode.isDark(row + 1, col) ) count += 1;
              if (qrcode.isDark(row, col + 1) ) count += 1;
              if (qrcode.isDark(row + 1, col + 1) ) count += 1;
              if (count == 0 || count == 4) {
                lostPoint += 3;
              }
            }
          }

          // LEVEL3

          for (var row = 0; row < moduleCount; row += 1) {
            for (var col = 0; col < moduleCount - 6; col += 1) {
              if (qrcode.isDark(row, col)
                  && !qrcode.isDark(row, col + 1)
                  &&  qrcode.isDark(row, col + 2)
                  &&  qrcode.isDark(row, col + 3)
                  &&  qrcode.isDark(row, col + 4)
                  && !qrcode.isDark(row, col + 5)
                  &&  qrcode.isDark(row, col + 6) ) {
                lostPoint += 40;
              }
            }
          }

          for (var col = 0; col < moduleCount; col += 1) {
            for (var row = 0; row < moduleCount - 6; row += 1) {
              if (qrcode.isDark(row, col)
                  && !qrcode.isDark(row + 1, col)
                  &&  qrcode.isDark(row + 2, col)
                  &&  qrcode.isDark(row + 3, col)
                  &&  qrcode.isDark(row + 4, col)
                  && !qrcode.isDark(row + 5, col)
                  &&  qrcode.isDark(row + 6, col) ) {
                lostPoint += 40;
              }
            }
          }

          // LEVEL4

          var darkCount = 0;

          for (var col = 0; col < moduleCount; col += 1) {
            for (var row = 0; row < moduleCount; row += 1) {
              if (qrcode.isDark(row, col) ) {
                darkCount += 1;
              }
            }
          }

          var ratio = Math.abs(100 * darkCount / moduleCount / moduleCount - 50) / 5;
          lostPoint += ratio * 10;

          return lostPoint;
        };

        return _this;
      }();

      //---------------------------------------------------------------------
      // QRMath
      //---------------------------------------------------------------------

      var QRMath = function() {

        var EXP_TABLE = new Array(256);
        var LOG_TABLE = new Array(256);

        // initialize tables
        for (var i = 0; i < 8; i += 1) {
          EXP_TABLE[i] = 1 << i;
        }
        for (var i = 8; i < 256; i += 1) {
          EXP_TABLE[i] = EXP_TABLE[i - 4]
            ^ EXP_TABLE[i - 5]
            ^ EXP_TABLE[i - 6]
            ^ EXP_TABLE[i - 8];
        }
        for (var i = 0; i < 255; i += 1) {
          LOG_TABLE[EXP_TABLE[i] ] = i;
        }

        var _this = {};

        _this.glog = function(n) {

          if (n < 1) {
            throw 'glog(' + n + ')';
          }

          return LOG_TABLE[n];
        };

        _this.gexp = function(n) {

          while (n < 0) {
            n += 255;
          }

          while (n >= 256) {
            n -= 255;
          }

          return EXP_TABLE[n];
        };

        return _this;
      }();

      //---------------------------------------------------------------------
      // qrPolynomial
      //---------------------------------------------------------------------

      function qrPolynomial(num, shift) {

        if (typeof num.length == 'undefined') {
          throw num.length + '/' + shift;
        }

        var _num = function() {
          var offset = 0;
          while (offset < num.length && num[offset] == 0) {
            offset += 1;
          }
          var _num = new Array(num.length - offset + shift);
          for (var i = 0; i < num.length - offset; i += 1) {
            _num[i] = num[i + offset];
          }
          return _num;
        }();

        var _this = {};

        _this.getAt = function(index) {
          return _num[index];
        };

        _this.getLength = function() {
          return _num.length;
        };

        _this.multiply = function(e) {

          var num = new Array(_this.getLength() + e.getLength() - 1);

          for (var i = 0; i < _this.getLength(); i += 1) {
            for (var j = 0; j < e.getLength(); j += 1) {
              num[i + j] ^= QRMath.gexp(QRMath.glog(_this.getAt(i) ) + QRMath.glog(e.getAt(j) ) );
            }
          }

          return qrPolynomial(num, 0);
        };

        _this.mod = function(e) {

          if (_this.getLength() - e.getLength() < 0) {
            return _this;
          }

          var ratio = QRMath.glog(_this.getAt(0) ) - QRMath.glog(e.getAt(0) );

          var num = new Array(_this.getLength() );
          for (var i = 0; i < _this.getLength(); i += 1) {
            num[i] = _this.getAt(i);
          }

          for (var i = 0; i < e.getLength(); i += 1) {
            num[i] ^= QRMath.gexp(QRMath.glog(e.getAt(i) ) + ratio);
          }

          // recursive call
          return qrPolynomial(num, 0).mod(e);
        };

        return _this;
      };

      //---------------------------------------------------------------------
      // QRRSBlock
      //---------------------------------------------------------------------

      var QRRSBlock = function() {

        var RS_BLOCK_TABLE = [

          // L
          // M
          // Q
          // H

          // 1
          [1, 26, 19],
          [1, 26, 16],
          [1, 26, 13],
          [1, 26, 9],

          // 2
          [1, 44, 34],
          [1, 44, 28],
          [1, 44, 22],
          [1, 44, 16],

          // 3
          [1, 70, 55],
          [1, 70, 44],
          [2, 35, 17],
          [2, 35, 13],

          // 4
          [1, 100, 80],
          [2, 50, 32],
          [2, 50, 24],
          [4, 25, 9],

          // 5
          [1, 134, 108],
          [2, 67, 43],
          [2, 33, 15, 2, 34, 16],
          [2, 33, 11, 2, 34, 12],

          // 6
          [2, 86, 68],
          [4, 43, 27],
          [4, 43, 19],
          [4, 43, 15],

          // 7
          [2, 98, 78],
          [4, 49, 31],
          [2, 32, 14, 4, 33, 15],
          [4, 39, 13, 1, 40, 14],

          // 8
          [2, 121, 97],
          [2, 60, 38, 2, 61, 39],
          [4, 40, 18, 2, 41, 19],
          [4, 40, 14, 2, 41, 15],

          // 9
          [2, 146, 116],
          [3, 58, 36, 2, 59, 37],
          [4, 36, 16, 4, 37, 17],
          [4, 36, 12, 4, 37, 13],

          // 10
          [2, 86, 68, 2, 87, 69],
          [4, 69, 43, 1, 70, 44],
          [6, 43, 19, 2, 44, 20],
          [6, 43, 15, 2, 44, 16],

          // 11
          [4, 101, 81],
          [1, 80, 50, 4, 81, 51],
          [4, 50, 22, 4, 51, 23],
          [3, 36, 12, 8, 37, 13],

          // 12
          [2, 116, 92, 2, 117, 93],
          [6, 58, 36, 2, 59, 37],
          [4, 46, 20, 6, 47, 21],
          [7, 42, 14, 4, 43, 15],

          // 13
          [4, 133, 107],
          [8, 59, 37, 1, 60, 38],
          [8, 44, 20, 4, 45, 21],
          [12, 33, 11, 4, 34, 12],

          // 14
          [3, 145, 115, 1, 146, 116],
          [4, 64, 40, 5, 65, 41],
          [11, 36, 16, 5, 37, 17],
          [11, 36, 12, 5, 37, 13],

          // 15
          [5, 109, 87, 1, 110, 88],
          [5, 65, 41, 5, 66, 42],
          [5, 54, 24, 7, 55, 25],
          [11, 36, 12, 7, 37, 13],

          // 16
          [5, 122, 98, 1, 123, 99],
          [7, 73, 45, 3, 74, 46],
          [15, 43, 19, 2, 44, 20],
          [3, 45, 15, 13, 46, 16],

          // 17
          [1, 135, 107, 5, 136, 108],
          [10, 74, 46, 1, 75, 47],
          [1, 50, 22, 15, 51, 23],
          [2, 42, 14, 17, 43, 15],

          // 18
          [5, 150, 120, 1, 151, 121],
          [9, 69, 43, 4, 70, 44],
          [17, 50, 22, 1, 51, 23],
          [2, 42, 14, 19, 43, 15],

          // 19
          [3, 141, 113, 4, 142, 114],
          [3, 70, 44, 11, 71, 45],
          [17, 47, 21, 4, 48, 22],
          [9, 39, 13, 16, 40, 14],

          // 20
          [3, 135, 107, 5, 136, 108],
          [3, 67, 41, 13, 68, 42],
          [15, 54, 24, 5, 55, 25],
          [15, 43, 15, 10, 44, 16],

          // 21
          [4, 144, 116, 4, 145, 117],
          [17, 68, 42],
          [17, 50, 22, 6, 51, 23],
          [19, 46, 16, 6, 47, 17],

          // 22
          [2, 139, 111, 7, 140, 112],
          [17, 74, 46],
          [7, 54, 24, 16, 55, 25],
          [34, 37, 13],

          // 23
          [4, 151, 121, 5, 152, 122],
          [4, 75, 47, 14, 76, 48],
          [11, 54, 24, 14, 55, 25],
          [16, 45, 15, 14, 46, 16],

          // 24
          [6, 147, 117, 4, 148, 118],
          [6, 73, 45, 14, 74, 46],
          [11, 54, 24, 16, 55, 25],
          [30, 46, 16, 2, 47, 17],

          // 25
          [8, 132, 106, 4, 133, 107],
          [8, 75, 47, 13, 76, 48],
          [7, 54, 24, 22, 55, 25],
          [22, 45, 15, 13, 46, 16],

          // 26
          [10, 142, 114, 2, 143, 115],
          [19, 74, 46, 4, 75, 47],
          [28, 50, 22, 6, 51, 23],
          [33, 46, 16, 4, 47, 17],

          // 27
          [8, 152, 122, 4, 153, 123],
          [22, 73, 45, 3, 74, 46],
          [8, 53, 23, 26, 54, 24],
          [12, 45, 15, 28, 46, 16],

          // 28
          [3, 147, 117, 10, 148, 118],
          [3, 73, 45, 23, 74, 46],
          [4, 54, 24, 31, 55, 25],
          [11, 45, 15, 31, 46, 16],

          // 29
          [7, 146, 116, 7, 147, 117],
          [21, 73, 45, 7, 74, 46],
          [1, 53, 23, 37, 54, 24],
          [19, 45, 15, 26, 46, 16],

          // 30
          [5, 145, 115, 10, 146, 116],
          [19, 75, 47, 10, 76, 48],
          [15, 54, 24, 25, 55, 25],
          [23, 45, 15, 25, 46, 16],

          // 31
          [13, 145, 115, 3, 146, 116],
          [2, 74, 46, 29, 75, 47],
          [42, 54, 24, 1, 55, 25],
          [23, 45, 15, 28, 46, 16],

          // 32
          [17, 145, 115],
          [10, 74, 46, 23, 75, 47],
          [10, 54, 24, 35, 55, 25],
          [19, 45, 15, 35, 46, 16],

          // 33
          [17, 145, 115, 1, 146, 116],
          [14, 74, 46, 21, 75, 47],
          [29, 54, 24, 19, 55, 25],
          [11, 45, 15, 46, 46, 16],

          // 34
          [13, 145, 115, 6, 146, 116],
          [14, 74, 46, 23, 75, 47],
          [44, 54, 24, 7, 55, 25],
          [59, 46, 16, 1, 47, 17],

          // 35
          [12, 151, 121, 7, 152, 122],
          [12, 75, 47, 26, 76, 48],
          [39, 54, 24, 14, 55, 25],
          [22, 45, 15, 41, 46, 16],

          // 36
          [6, 151, 121, 14, 152, 122],
          [6, 75, 47, 34, 76, 48],
          [46, 54, 24, 10, 55, 25],
          [2, 45, 15, 64, 46, 16],

          // 37
          [17, 152, 122, 4, 153, 123],
          [29, 74, 46, 14, 75, 47],
          [49, 54, 24, 10, 55, 25],
          [24, 45, 15, 46, 46, 16],

          // 38
          [4, 152, 122, 18, 153, 123],
          [13, 74, 46, 32, 75, 47],
          [48, 54, 24, 14, 55, 25],
          [42, 45, 15, 32, 46, 16],

          // 39
          [20, 147, 117, 4, 148, 118],
          [40, 75, 47, 7, 76, 48],
          [43, 54, 24, 22, 55, 25],
          [10, 45, 15, 67, 46, 16],

          // 40
          [19, 148, 118, 6, 149, 119],
          [18, 75, 47, 31, 76, 48],
          [34, 54, 24, 34, 55, 25],
          [20, 45, 15, 61, 46, 16]
        ];

        var qrRSBlock = function(totalCount, dataCount) {
          var _this = {};
          _this.totalCount = totalCount;
          _this.dataCount = dataCount;
          return _this;
        };

        var _this = {};

        var getRsBlockTable = function(typeNumber, errorCorrectionLevel) {

          switch(errorCorrectionLevel) {
          case QRErrorCorrectionLevel.L :
            return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];
          case QRErrorCorrectionLevel.M :
            return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];
          case QRErrorCorrectionLevel.Q :
            return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];
          case QRErrorCorrectionLevel.H :
            return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];
          default :
            return undefined;
          }
        };

        _this.getRSBlocks = function(typeNumber, errorCorrectionLevel) {

          var rsBlock = getRsBlockTable(typeNumber, errorCorrectionLevel);

          if (typeof rsBlock == 'undefined') {
            throw 'bad rs block @ typeNumber:' + typeNumber +
                '/errorCorrectionLevel:' + errorCorrectionLevel;
          }

          var length = rsBlock.length / 3;

          var list = [];

          for (var i = 0; i < length; i += 1) {

            var count = rsBlock[i * 3 + 0];
            var totalCount = rsBlock[i * 3 + 1];
            var dataCount = rsBlock[i * 3 + 2];

            for (var j = 0; j < count; j += 1) {
              list.push(qrRSBlock(totalCount, dataCount) );
            }
          }

          return list;
        };

        return _this;
      }();

      //---------------------------------------------------------------------
      // qrBitBuffer
      //---------------------------------------------------------------------

      var qrBitBuffer = function() {

        var _buffer = [];
        var _length = 0;

        var _this = {};

        _this.getBuffer = function() {
          return _buffer;
        };

        _this.getAt = function(index) {
          var bufIndex = Math.floor(index / 8);
          return ( (_buffer[bufIndex] >>> (7 - index % 8) ) & 1) == 1;
        };

        _this.put = function(num, length) {
          for (var i = 0; i < length; i += 1) {
            _this.putBit( ( (num >>> (length - i - 1) ) & 1) == 1);
          }
        };

        _this.getLengthInBits = function() {
          return _length;
        };

        _this.putBit = function(bit) {

          var bufIndex = Math.floor(_length / 8);
          if (_buffer.length <= bufIndex) {
            _buffer.push(0);
          }

          if (bit) {
            _buffer[bufIndex] |= (0x80 >>> (_length % 8) );
          }

          _length += 1;
        };

        return _this;
      };

      //---------------------------------------------------------------------
      // qrNumber
      //---------------------------------------------------------------------

      var qrNumber = function(data) {

        var _mode = QRMode.MODE_NUMBER;
        var _data = data;

        var _this = {};

        _this.getMode = function() {
          return _mode;
        };

        _this.getLength = function(buffer) {
          return _data.length;
        };

        _this.write = function(buffer) {

          var data = _data;

          var i = 0;

          while (i + 2 < data.length) {
            buffer.put(strToNum(data.substring(i, i + 3) ), 10);
            i += 3;
          }

          if (i < data.length) {
            if (data.length - i == 1) {
              buffer.put(strToNum(data.substring(i, i + 1) ), 4);
            } else if (data.length - i == 2) {
              buffer.put(strToNum(data.substring(i, i + 2) ), 7);
            }
          }
        };

        var strToNum = function(s) {
          var num = 0;
          for (var i = 0; i < s.length; i += 1) {
            num = num * 10 + chatToNum(s.charAt(i) );
          }
          return num;
        };

        var chatToNum = function(c) {
          if ('0' <= c && c <= '9') {
            return c.charCodeAt(0) - '0'.charCodeAt(0);
          }
          throw 'illegal char :' + c;
        };

        return _this;
      };

      //---------------------------------------------------------------------
      // qrAlphaNum
      //---------------------------------------------------------------------

      var qrAlphaNum = function(data) {

        var _mode = QRMode.MODE_ALPHA_NUM;
        var _data = data;

        var _this = {};

        _this.getMode = function() {
          return _mode;
        };

        _this.getLength = function(buffer) {
          return _data.length;
        };

        _this.write = function(buffer) {

          var s = _data;

          var i = 0;

          while (i + 1 < s.length) {
            buffer.put(
              getCode(s.charAt(i) ) * 45 +
              getCode(s.charAt(i + 1) ), 11);
            i += 2;
          }

          if (i < s.length) {
            buffer.put(getCode(s.charAt(i) ), 6);
          }
        };

        var getCode = function(c) {

          if ('0' <= c && c <= '9') {
            return c.charCodeAt(0) - '0'.charCodeAt(0);
          } else if ('A' <= c && c <= 'Z') {
            return c.charCodeAt(0) - 'A'.charCodeAt(0) + 10;
          } else {
            switch (c) {
            case ' ' : return 36;
            case '$' : return 37;
            case '%' : return 38;
            case '*' : return 39;
            case '+' : return 40;
            case '-' : return 41;
            case '.' : return 42;
            case '/' : return 43;
            case ':' : return 44;
            default :
              throw 'illegal char :' + c;
            }
          }
        };

        return _this;
      };

      //---------------------------------------------------------------------
      // qr8BitByte
      //---------------------------------------------------------------------

      var qr8BitByte = function(data) {

        var _mode = QRMode.MODE_8BIT_BYTE;
        var _data = data;
        var _bytes = qrcode.stringToBytes(data);

        var _this = {};

        _this.getMode = function() {
          return _mode;
        };

        _this.getLength = function(buffer) {
          return _bytes.length;
        };

        _this.write = function(buffer) {
          for (var i = 0; i < _bytes.length; i += 1) {
            buffer.put(_bytes[i], 8);
          }
        };

        return _this;
      };

      //---------------------------------------------------------------------
      // qrKanji
      //---------------------------------------------------------------------

      var qrKanji = function(data) {

        var _mode = QRMode.MODE_KANJI;
        var _data = data;

        var stringToBytes = qrcode.stringToBytesFuncs['SJIS'];
        if (!stringToBytes) {
          throw 'sjis not supported.';
        }
        !function(c, code) {
          // self test for sjis support.
          var test = stringToBytes(c);
          if (test.length != 2 || ( (test[0] << 8) | test[1]) != code) {
            throw 'sjis not supported.';
          }
        }('\u53cb', 0x9746);

        var _bytes = stringToBytes(data);

        var _this = {};

        _this.getMode = function() {
          return _mode;
        };

        _this.getLength = function(buffer) {
          return ~~(_bytes.length / 2);
        };

        _this.write = function(buffer) {

          var data = _bytes;

          var i = 0;

          while (i + 1 < data.length) {

            var c = ( (0xff & data[i]) << 8) | (0xff & data[i + 1]);

            if (0x8140 <= c && c <= 0x9FFC) {
              c -= 0x8140;
            } else if (0xE040 <= c && c <= 0xEBBF) {
              c -= 0xC140;
            } else {
              throw 'illegal char at ' + (i + 1) + '/' + c;
            }

            c = ( (c >>> 8) & 0xff) * 0xC0 + (c & 0xff);

            buffer.put(c, 13);

            i += 2;
          }

          if (i < data.length) {
            throw 'illegal char at ' + (i + 1);
          }
        };

        return _this;
      };

      //=====================================================================
      // GIF Support etc.
      //

      //---------------------------------------------------------------------
      // byteArrayOutputStream
      //---------------------------------------------------------------------

      var byteArrayOutputStream = function() {

        var _bytes = [];

        var _this = {};

        _this.writeByte = function(b) {
          _bytes.push(b & 0xff);
        };

        _this.writeShort = function(i) {
          _this.writeByte(i);
          _this.writeByte(i >>> 8);
        };

        _this.writeBytes = function(b, off, len) {
          off = off || 0;
          len = len || b.length;
          for (var i = 0; i < len; i += 1) {
            _this.writeByte(b[i + off]);
          }
        };

        _this.writeString = function(s) {
          for (var i = 0; i < s.length; i += 1) {
            _this.writeByte(s.charCodeAt(i) );
          }
        };

        _this.toByteArray = function() {
          return _bytes;
        };

        _this.toString = function() {
          var s = '';
          s += '[';
          for (var i = 0; i < _bytes.length; i += 1) {
            if (i > 0) {
              s += ',';
            }
            s += _bytes[i];
          }
          s += ']';
          return s;
        };

        return _this;
      };

      //---------------------------------------------------------------------
      // base64EncodeOutputStream
      //---------------------------------------------------------------------

      var base64EncodeOutputStream = function() {

        var _buffer = 0;
        var _buflen = 0;
        var _length = 0;
        var _base64 = '';

        var _this = {};

        var writeEncoded = function(b) {
          _base64 += String.fromCharCode(encode(b & 0x3f) );
        };

        var encode = function(n) {
          if (n < 0) {
            // error.
          } else if (n < 26) {
            return 0x41 + n;
          } else if (n < 52) {
            return 0x61 + (n - 26);
          } else if (n < 62) {
            return 0x30 + (n - 52);
          } else if (n == 62) {
            return 0x2b;
          } else if (n == 63) {
            return 0x2f;
          }
          throw 'n:' + n;
        };

        _this.writeByte = function(n) {

          _buffer = (_buffer << 8) | (n & 0xff);
          _buflen += 8;
          _length += 1;

          while (_buflen >= 6) {
            writeEncoded(_buffer >>> (_buflen - 6) );
            _buflen -= 6;
          }
        };

        _this.flush = function() {

          if (_buflen > 0) {
            writeEncoded(_buffer << (6 - _buflen) );
            _buffer = 0;
            _buflen = 0;
          }

          if (_length % 3 != 0) {
            // padding
            var padlen = 3 - _length % 3;
            for (var i = 0; i < padlen; i += 1) {
              _base64 += '=';
            }
          }
        };

        _this.toString = function() {
          return _base64;
        };

        return _this;
      };

      //---------------------------------------------------------------------
      // base64DecodeInputStream
      //---------------------------------------------------------------------

      var base64DecodeInputStream = function(str) {

        var _str = str;
        var _pos = 0;
        var _buffer = 0;
        var _buflen = 0;

        var _this = {};

        _this.read = function() {

          while (_buflen < 8) {

            if (_pos >= _str.length) {
              if (_buflen == 0) {
                return -1;
              }
              throw 'unexpected end of file./' + _buflen;
            }

            var c = _str.charAt(_pos);
            _pos += 1;

            if (c == '=') {
              _buflen = 0;
              return -1;
            } else if (c.match(/^\s$/) ) {
              // ignore if whitespace.
              continue;
            }

            _buffer = (_buffer << 6) | decode(c.charCodeAt(0) );
            _buflen += 6;
          }

          var n = (_buffer >>> (_buflen - 8) ) & 0xff;
          _buflen -= 8;
          return n;
        };

        var decode = function(c) {
          if (0x41 <= c && c <= 0x5a) {
            return c - 0x41;
          } else if (0x61 <= c && c <= 0x7a) {
            return c - 0x61 + 26;
          } else if (0x30 <= c && c <= 0x39) {
            return c - 0x30 + 52;
          } else if (c == 0x2b) {
            return 62;
          } else if (c == 0x2f) {
            return 63;
          } else {
            throw 'c:' + c;
          }
        };

        return _this;
      };

      //---------------------------------------------------------------------
      // gifImage (B/W)
      //---------------------------------------------------------------------

      var gifImage = function(width, height) {

        var _width = width;
        var _height = height;
        var _data = new Array(width * height);

        var _this = {};

        _this.setPixel = function(x, y, pixel) {
          _data[y * _width + x] = pixel;
        };

        _this.write = function(out) {

          //---------------------------------
          // GIF Signature

          out.writeString('GIF87a');

          //---------------------------------
          // Screen Descriptor

          out.writeShort(_width);
          out.writeShort(_height);

          out.writeByte(0x80); // 2bit
          out.writeByte(0);
          out.writeByte(0);

          //---------------------------------
          // Global Color Map

          // black
          out.writeByte(0x00);
          out.writeByte(0x00);
          out.writeByte(0x00);

          // white
          out.writeByte(0xff);
          out.writeByte(0xff);
          out.writeByte(0xff);

          //---------------------------------
          // Image Descriptor

          out.writeString(',');
          out.writeShort(0);
          out.writeShort(0);
          out.writeShort(_width);
          out.writeShort(_height);
          out.writeByte(0);

          //---------------------------------
          // Local Color Map

          //---------------------------------
          // Raster Data

          var lzwMinCodeSize = 2;
          var raster = getLZWRaster(lzwMinCodeSize);

          out.writeByte(lzwMinCodeSize);

          var offset = 0;

          while (raster.length - offset > 255) {
            out.writeByte(255);
            out.writeBytes(raster, offset, 255);
            offset += 255;
          }

          out.writeByte(raster.length - offset);
          out.writeBytes(raster, offset, raster.length - offset);
          out.writeByte(0x00);

          //---------------------------------
          // GIF Terminator
          out.writeString(';');
        };

        var bitOutputStream = function(out) {

          var _out = out;
          var _bitLength = 0;
          var _bitBuffer = 0;

          var _this = {};

          _this.write = function(data, length) {

            if ( (data >>> length) != 0) {
              throw 'length over';
            }

            while (_bitLength + length >= 8) {
              _out.writeByte(0xff & ( (data << _bitLength) | _bitBuffer) );
              length -= (8 - _bitLength);
              data >>>= (8 - _bitLength);
              _bitBuffer = 0;
              _bitLength = 0;
            }

            _bitBuffer = (data << _bitLength) | _bitBuffer;
            _bitLength = _bitLength + length;
          };

          _this.flush = function() {
            if (_bitLength > 0) {
              _out.writeByte(_bitBuffer);
            }
          };

          return _this;
        };

        var getLZWRaster = function(lzwMinCodeSize) {

          var clearCode = 1 << lzwMinCodeSize;
          var endCode = (1 << lzwMinCodeSize) + 1;
          var bitLength = lzwMinCodeSize + 1;

          // Setup LZWTable
          var table = lzwTable();

          for (var i = 0; i < clearCode; i += 1) {
            table.add(String.fromCharCode(i) );
          }
          table.add(String.fromCharCode(clearCode) );
          table.add(String.fromCharCode(endCode) );

          var byteOut = byteArrayOutputStream();
          var bitOut = bitOutputStream(byteOut);

          // clear code
          bitOut.write(clearCode, bitLength);

          var dataIndex = 0;

          var s = String.fromCharCode(_data[dataIndex]);
          dataIndex += 1;

          while (dataIndex < _data.length) {

            var c = String.fromCharCode(_data[dataIndex]);
            dataIndex += 1;

            if (table.contains(s + c) ) {

              s = s + c;

            } else {

              bitOut.write(table.indexOf(s), bitLength);

              if (table.size() < 0xfff) {

                if (table.size() == (1 << bitLength) ) {
                  bitLength += 1;
                }

                table.add(s + c);
              }

              s = c;
            }
          }

          bitOut.write(table.indexOf(s), bitLength);

          // end code
          bitOut.write(endCode, bitLength);

          bitOut.flush();

          return byteOut.toByteArray();
        };

        var lzwTable = function() {

          var _map = {};
          var _size = 0;

          var _this = {};

          _this.add = function(key) {
            if (_this.contains(key) ) {
              throw 'dup key:' + key;
            }
            _map[key] = _size;
            _size += 1;
          };

          _this.size = function() {
            return _size;
          };

          _this.indexOf = function(key) {
            return _map[key];
          };

          _this.contains = function(key) {
            return typeof _map[key] != 'undefined';
          };

          return _this;
        };

        return _this;
      };

      var createDataURL = function(width, height, getPixel) {
        var gif = gifImage(width, height);
        for (var y = 0; y < height; y += 1) {
          for (var x = 0; x < width; x += 1) {
            gif.setPixel(x, y, getPixel(x, y) );
          }
        }

        var b = byteArrayOutputStream();
        gif.write(b);

        var base64 = base64EncodeOutputStream();
        var bytes = b.toByteArray();
        for (var i = 0; i < bytes.length; i += 1) {
          base64.writeByte(bytes[i]);
        }
        base64.flush();

        return 'data:image/gif;base64,' + base64;
      };

      //---------------------------------------------------------------------
      // returns qrcode function.

      return qrcode;
    }();

    // multibyte support
    !function() {

      qrcode.stringToBytesFuncs['UTF-8'] = function(s) {
        // http://stackoverflow.com/questions/18729405/how-to-convert-utf8-string-to-byte-array
        function toUTF8Array(str) {
          var utf8 = [];
          for (var i=0; i < str.length; i++) {
            var charcode = str.charCodeAt(i);
            if (charcode < 0x80) utf8.push(charcode);
            else if (charcode < 0x800) {
              utf8.push(0xc0 | (charcode >> 6),
                  0x80 | (charcode & 0x3f));
            }
            else if (charcode < 0xd800 || charcode >= 0xe000) {
              utf8.push(0xe0 | (charcode >> 12),
                  0x80 | ((charcode>>6) & 0x3f),
                  0x80 | (charcode & 0x3f));
            }
            // surrogate pair
            else {
              i++;
              // UTF-16 encodes 0x10000-0x10FFFF by
              // subtracting 0x10000 and splitting the
              // 20 bits of 0x0-0xFFFFF into two halves
              charcode = 0x10000 + (((charcode & 0x3ff)<<10)
                | (str.charCodeAt(i) & 0x3ff));
              utf8.push(0xf0 | (charcode >>18),
                  0x80 | ((charcode>>12) & 0x3f),
                  0x80 | ((charcode>>6) & 0x3f),
                  0x80 | (charcode & 0x3f));
            }
          }
          return utf8;
        }
        return toUTF8Array(s);
      };

    }();

    const REPO = 'https://github.com/AIcivilization/dsh-vps'
    const INSTALL_CMD = 'curl -fsSL https://raw.githubusercontent.com/AIcivilization/dsh-vps/main/install.sh | sudo bash -s'

    // ——————————————————————— 文案 ———————————————————————

    // 跟随 DSH「设置 → 通用 → 语言」：交给 DSH 的语言服务按当前语言的回退链挑文案
    // （与 DSH 自身同一规则——中文及回退到中文的语言包显示中文，其余显示英文）。
    // 语言服务不可用（旧版 DSH）时按浏览器语言兜底。
    let localeSvc = null
    const browserZh = (() => {
      try {
        return /^zh/i.test(navigator.language || '')
      } catch {
        return true
      }
    })()
    const t = (cn, en) => {
      if (localeSvc && typeof localeSvc.resolveText === 'function') {
        try {
          return localeSvc.resolveText({ zh: cn, en })
        } catch {
          // 退回兜底
        }
      }
      return browserZh ? cn : en
    }
    /** 语言切换时让界面重渲染（DSH 的 LocaleFace：subscribe + getSnapshot().revision） */
    const noopSubscribe = () => () => {}
    function useLocaleRevision() {
      const ok = localeSvc && typeof localeSvc.subscribe === 'function' && typeof localeSvc.getSnapshot === 'function'
      return React.useSyncExternalStore(
        ok ? (fn) => localeSvc.subscribe(fn) : noopSubscribe,
        ok ? () => localeSvc.getSnapshot().revision : () => 0,
      )
    }

    // ——————————————————————— 样式（跟随 DSH 主题变量） ———————————————————————

    const T = {
      border: 'var(--border, var(--dsw-alias-border-l1, rgba(127,127,127,0.25)))',
      layer: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.10))',
      danger: 'var(--dsw-alias-state-error-primary, #e5534b)',
      ok: 'var(--dsw-alias-state-success-primary, #2ea043)',
      accent: 'var(--primary, #3b82f6)',
    }
    const line = `1px solid ${T.border}`
    const S = {
      root: { fontSize: 13, lineHeight: 1.6 },
      h2: { fontSize: 14, fontWeight: 600, margin: '0 0 8px' },
      card: { border: line, borderRadius: 8, padding: 12, marginBottom: 10 },
      spread: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      kv: { display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 16, rowGap: 4 },
      muted: { opacity: 0.6 },
      pre: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        background: T.layer,
        borderRadius: 6,
        padding: '8px 10px',
        overflowX: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        margin: 0,
      },
      code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
      btn: (kind, disabled) => ({
        border: kind === 'primary' ? `1px solid ${T.accent}` : line,
        background: kind === 'primary' ? T.accent : 'transparent',
        color: kind === 'primary' ? 'var(--primary-foreground, #fff)' : 'inherit',
        borderRadius: 6,
        padding: '4px 12px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        fontSize: 13,
        whiteSpace: 'nowrap',
      }),
      badge: (tone) => ({
        fontSize: 11,
        padding: '1px 7px',
        borderRadius: 10,
        border: line,
        color: tone === 'danger' ? T.danger : tone === 'ok' ? T.ok : tone === 'accent' ? T.accent : 'inherit',
        whiteSpace: 'nowrap',
      }),
      err: { border: `1px solid ${T.danger}`, color: T.danger, borderRadius: 6, padding: '8px 10px', marginTop: 8 },
      note: { border: line, borderRadius: 6, padding: '8px 10px', marginTop: 8, background: T.layer },
      // 勾选框始终贴在文字左边（窄窗口里文字换行，勾选框不单独占一行）
      check: { display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' },
      checkbox: { flex: 'none', marginTop: 4 },
    }

    // ——————————————————————— 与网关通信 ———————————————————————

    /** GET 网关接口；不是网关（普通 DSH 返回 404 或前端页面）时返回 null */
    async function gateGet(path) {
      try {
        const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(20_000) })
        if (!res.ok || !String(res.headers.get('content-type') || '').includes('application/json')) return null
        return await res.json()
      } catch {
        return null
      }
    }

    async function requestUpgrade() {
      const res = await fetch('/gate/update', { method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(30_000) })
      let body = {}
      try {
        body = await res.json()
      } catch {
        // 非 JSON：用状态码说话
      }
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      return body
    }

    // ——————————————————————— 小工具 ———————————————————————

    function ago(ms) {
      if (!ms) return t('尚未检查', 'not checked yet')
      const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
      if (s < 60) return t('刚刚', 'just now')
      if (s < 3600) return t(`${Math.round(s / 60)} 分钟前`, `${Math.round(s / 60)} min ago`)
      if (s < 86400) return t(`${Math.round(s / 3600)} 小时前`, `${Math.round(s / 3600)} h ago`)
      return t(`${Math.round(s / 86400)} 天前`, `${Math.round(s / 86400)} d ago`)
    }

    function duration(sec) {
      if (sec < 3600) return t(`${Math.max(1, Math.round(sec / 60))} 分钟`, `${Math.max(1, Math.round(sec / 60))} min`)
      if (sec < 86400) return t(`${Math.round(sec / 3600)} 小时`, `${Math.round(sec / 3600)} h`)
      return t(`${Math.round(sec / 86400)} 天`, `${Math.round(sec / 86400)} d`)
    }

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        // 非安全上下文拿不到 clipboard：退回 execCommand
        try {
          const ta = document.createElement('textarea')
          ta.value = text
          ta.style.position = 'fixed'
          ta.style.opacity = '0'
          document.body.appendChild(ta)
          ta.select()
          const ok = document.execCommand('copy')
          ta.remove()
          return ok
        } catch {
          return false
        }
      }
    }

    function CopyLine({ text, note }) {
      const [copied, setCopied] = useState(false)
      return h('div', { style: { marginTop: 6 } },
        h('div', { style: { ...S.row, flexWrap: 'nowrap', alignItems: 'stretch' } },
          h('pre', { style: { ...S.pre, flex: 1 } }, text),
          h('button', {
            type: 'button',
            style: S.btn(),
            onClick: async () => {
              setCopied(await copyText(text))
              setTimeout(() => setCopied(false), 1500)
            },
          }, copied ? t('已复制', 'Copied') : t('复制', 'Copy'))),
        note ? h('div', { style: { ...S.muted, fontSize: 12, marginTop: 2 } }, note) : null)
    }

    // ——————————————————————— 部署在 dsh-vps 上 ———————————————————————

    function VersionCard({ info, reload }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [upgrading, setUpgrading] = useState(false)
      const [checking, setChecking] = useState(false)
      const startedAt = useRef(0)
      const timer = useRef(null)

      const st = info.status
      const running = info.requested || (st && st.state === 'running')

      const poll = useCallback(() => {
        clearInterval(timer.current)
        timer.current = setInterval(async () => {
          const next = await gateGet('/gate/update')
          if (!next) return // 升级中网关会重启一次，连不上属正常，继续等
          reload(next)
          const s = next.status
          if (!next.requested && s && s.state !== 'running' && s.at >= startedAt.current) {
            clearInterval(timer.current)
            setUpgrading(false)
            if (s.state === 'success') setTimeout(() => window.location.reload(), 1500)
          }
        }, 3000)
      }, [reload])

      useEffect(() => {
        if (running) {
          startedAt.current = startedAt.current || Date.now() - 60_000
          setUpgrading(true)
          poll()
        }
        return () => clearInterval(timer.current)
      }, []) // eslint-disable-line react-hooks/exhaustive-deps

      async function upgrade() {
        const msg = t(
          `升级 DeepSeek Harness 到 ${info.latest}？\n\n升级期间 DSH 会重启，约 1–3 分钟不可用。升级前自动备份；新版本自检不通过会自动回滚到当前版本。`,
          `Upgrade DeepSeek Harness to ${info.latest}?\n\nDSH restarts during the upgrade and is unavailable for about 1–3 minutes. A backup is taken first; if the new version fails its self-check, it rolls back automatically.`,
        )
        if (!window.confirm(msg)) return
        setBusy(true)
        setError(null)
        try {
          startedAt.current = Date.now() - 5_000
          await requestUpgrade()
          setUpgrading(true)
          poll()
        } catch (e) {
          setError(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      async function check() {
        setChecking(true)
        const next = await gateGet('/gate/update?refresh=1')
        if (next) reload(next)
        setChecking(false)
      }

      const finished = !upgrading && st && st.state !== 'running' && Date.now() - st.at < 24 * 3600_000
      return h('div', { style: S.card },
        h('div', { style: S.spread },
          h('div', { style: S.h2 }, 'DeepSeek Harness'),
          info.available
            ? h('span', { style: S.badge('accent') }, t('有新版本', 'Update available'))
            : info.latest ? h('span', { style: S.badge('ok') }, t('已是最新', 'Up to date')) : null),
        h('div', { style: S.kv },
          h('span', { style: S.muted }, t('当前版本', 'Current')), h('span', { style: S.code }, info.current || '—'),
          h('span', { style: S.muted }, t('官方最新', 'Latest')),
          h('span', null, h('span', { style: S.code }, info.latest || '—'),
            h('span', { style: { ...S.muted, marginLeft: 8, fontSize: 12 } }, t(`检查于 ${ago(info.checkedAt)}`, `checked ${ago(info.checkedAt)}`)))),
        h('div', { style: { ...S.muted, fontSize: 12, marginTop: 4 } },
          t(`跟随官方发布：npm 上 latest（正式）与 next（预览）两个渠道中版本号较高的一个；新版本发布满 ${info.cooldownHours ?? 12} 小时后才提供升级，避开上游刚发布时的缺包。`,
            `Follows official releases: the higher of the npm \`latest\` (stable) and \`next\` (preview) channels, offered ${info.cooldownHours ?? 12} hours after release so upstream has time to finish publishing.`)),
        info.pending
          ? h('div', { style: S.note }, t(
            `${info.pending.version} 刚发布不久，${info.pending.availableAt ? `约 ${Math.max(1, Math.ceil((info.pending.availableAt - Date.now()) / 3600_000))} 小时后` : '稍后'}可以升级。`,
            `${info.pending.version} was released recently; it can be installed ${info.pending.availableAt ? `in about ${Math.max(1, Math.ceil((info.pending.availableAt - Date.now()) / 3600_000))} h` : 'later'}.`))
          : null,
        upgrading
          ? h('div', { style: S.note }, t(
            `正在升级${info.latest ? ` 到 ${info.latest}` : ''}…（约 1–3 分钟，期间页面会短暂不可用，完成后自动刷新）`,
            `Upgrading${info.latest ? ` to ${info.latest}` : ''}… (about 1–3 minutes; the page is briefly unavailable and reloads when done)`))
          : h('div', { style: { ...S.row, marginTop: 10 } },
            h('button', { type: 'button', style: S.btn(null, checking), disabled: checking, onClick: check },
              checking ? t('检查中…', 'Checking…') : t('检查更新', 'Check for updates')),
            info.available
              ? h('button', { type: 'button', style: S.btn('primary', busy), disabled: busy, onClick: upgrade },
                t(`升级到 ${info.latest}`, `Upgrade to ${info.latest}`))
              : null),
        error ? h('div', { style: S.err }, t(`无法开始升级：${error}`, `Could not start the upgrade: ${error}`)) : null,
        finished && st.state === 'success'
          ? h('div', { style: S.note }, t(`最近一次升级成功：${st.from} → ${st.to}（${ago(st.at)}）`, `Last upgrade succeeded: ${st.from} → ${st.to} (${ago(st.at)})`))
          : null,
        finished && st.state === 'failed'
          ? h('div', { style: S.err },
            h('div', null, t(`最近一次升级未成功（${ago(st.at)}），已保持在 ${st.to || st.from}，可以正常使用。`,
              `The last upgrade did not succeed (${ago(st.at)}); DSH stayed on ${st.to || st.from} and works normally.`)),
            info.logTail ? h('pre', { style: { ...S.pre, marginTop: 6, color: 'inherit' } }, info.logTail) : null)
          : null)
    }

    /** 二维码矩阵转成一条 SVG 路径（每个深色模块一个 1×1 方块） */
    function qrPath(text) {
      const q = qrcode(0, 'M')
      q.addData(text)
      q.make()
      const n = q.getModuleCount()
      let d = ''
      for (let r = 0; r < n; r += 1) {
        for (let c = 0; c < n; c += 1) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`
      }
      return { n, d }
    }

    const isIpHost = (host) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')

    /** 手机扫码打开，把 DSH 当作应用添加到桌面（左二维码、右说明，尽量矮） */
    function HomeScreenCard({ health }) {
      const url = `${window.location.origin}/`
      const host = window.location.hostname
      let qr = null
      try {
        qr = qrPath(url)
      } catch {
        qr = null
      }
      const small = { ...S.muted, fontSize: 12, lineHeight: 1.6 }
      const warn = { fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-state-warning-primary, #d29922)', marginTop: 4 }
      return h('div', { style: { ...S.card, display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center' } },
        qr
          ? h('svg', {
            viewBox: `-2 -2 ${qr.n + 4} ${qr.n + 4}`, width: 112, height: 112, shapeRendering: 'crispEdges',
            role: 'img', 'aria-label': url,
            // 二维码始终白底黑块：深色主题下反色会让部分手机识别不了
            style: { flex: 'none', background: '#fff', borderRadius: 6 },
          }, h('path', { d: qr.d, fill: '#000' }))
          : null,
        h('div', { style: { flex: '1 1 220px', minWidth: 0 } },
          h('div', { style: { fontWeight: 600, marginBottom: 2 } }, t('添加到手机桌面', 'Add to your phone\'s home screen')),
          h('div', { style: small },
            h('div', null, t('手机扫码打开并登录，然后：', 'Scan with your phone, sign in, then:')),
            h('div', null, t('iPhone（Safari）：分享 → 添加到主屏幕', 'iPhone (Safari): Share → Add to Home Screen')),
            h('div', null, t('安卓（Chrome）：菜单 ⋮ → 添加到主屏幕 / 安装应用', 'Android (Chrome): menu ⋮ → Add to Home screen / Install app')),
            h('div', null, t('电脑：Safari 文件 → 添加到程序坞；Chrome 地址栏右侧「安装」', 'Computer: Safari File → Add to Dock; Chrome “Install” at the right of the address bar'))),
          h('div', { style: { ...S.code, fontSize: 11, opacity: 0.6, marginTop: 2, wordBreak: 'break-all' } }, url),
          isIpHost(host)
            ? h('div', { style: warn }, t('当前用 IP 访问（自签证书），手机会提示不安全，桌面应用可能打不开；建议先在向导或 sudo dsh-vps 里配置域名。',
              'You are using an IP address (self-signed certificate): phones warn and a home-screen app may not open. Set up a domain first.'))
            : null,
          health?.access === 'tunnel'
            ? h('div', { style: warn }, t('已开启「仅隧道可访问」：手机需先连上 WireGuard 隧道才能打开。', 'Tunnel-only access is on: the phone must be connected to the WireGuard tunnel first.'))
            : null))
    }

    function GatewayCard({ health }) {
      if (!health) {
        return h('div', { style: S.card },
          h('div', { style: S.h2 }, t('网关', 'Gateway')),
          h('div', { style: S.muted }, t('读取网关状态失败，稍后刷新再试。', 'Could not read gateway status; refresh later.')))
      }
      const d = health.dsh || {}
      const cookie = health.dshCookie
      const tunnel = health.access === 'tunnel'
      return h('div', { style: S.card },
        h('div', { style: S.spread },
          h('div', { style: S.h2 }, t('网关', 'Gateway')),
          h('span', { style: S.badge(d.alive ? 'ok' : 'danger') }, d.alive ? t('运行正常', 'Healthy') : t('DSH 未运行', 'DSH not running'))),
        h('div', { style: S.kv },
          h('span', { style: S.muted }, t('访问地址', 'Address')), h('span', { style: S.code }, d.trustedHost ? `https://${d.trustedHost}` : '—'),
          h('span', { style: S.muted }, t('访问方式', 'Access')),
          h('span', null, tunnel
            ? t('仅 WireGuard 隧道内的设备可访问', 'WireGuard tunnel devices only')
            : t('公网可访问，凭管理员账号登录', 'Public, behind the admin login')),
          h('span', { style: S.muted }, t('网关已运行', 'Gateway uptime')), h('span', null, duration(health.uptimeSec || 0)),
          h('span', { style: S.muted }, t('DSH 重启次数', 'DSH restarts')), h('span', null, String(d.restarts ?? 0)),
          h('span', { style: S.muted }, t('DSH 会话', 'DSH session')),
          h('span', null, cookie
            ? t(`有效，剩余约 ${Math.max(0, Math.round(cookie.expiresInHours / 24))} 天（到期前自动续期）`,
              `valid, about ${Math.max(0, Math.round(cookie.expiresInHours / 24))} days left (renewed automatically)`)
            : t('尚未就绪', 'not ready'))),
        health.lastError ? h('div', { style: S.err }, health.lastError) : null)
    }

    /** 管理员账号：平时一行；点「修改密码」展开表单（要当前密码） */
    function AccountCard({ health }) {
      const [open, setOpen] = useState(false)
      const [form, setForm] = useState({ current: '', next: '', confirm: '' })
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [done, setDone] = useState(false)
      const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })
      const close = () => {
        setOpen(false)
        setForm({ current: '', next: '', confirm: '' })
        setError(null)
      }
      const messages = {
        wrong_current: t('当前密码不对。', 'The current password is wrong.'),
        too_short: t('新密码至少 12 位。', 'The new password needs at least 12 characters.'),
        too_long: t('新密码太长。', 'The new password is too long.'),
        same_as_current: t('新密码和当前密码一样。', 'The new password is the same as the current one.'),
        rate_limited: t('尝试次数过多，请稍后再试。', 'Too many attempts. Try again later.'),
        admin_changed: t('管理员账号已在别处变更，请刷新页面。', 'The admin account changed elsewhere; reload the page.'),
      }

      async function submit(e) {
        e.preventDefault()
        setError(null)
        if (form.next.length < 12) return setError(messages.too_short)
        if (form.next !== form.confirm) return setError(t('两次输入的新密码不一致。', 'The two new passwords do not match.'))
        setBusy(true)
        try {
          const res = await fetch('/gate/password', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ current: form.current, next: form.next }),
            signal: AbortSignal.timeout(20_000),
          })
          let body = {}
          try {
            body = await res.json()
          } catch {
            // 非 JSON
          }
          if (!res.ok) throw new Error(messages[body.error] || body.error || `HTTP ${res.status}`)
          close()
          setDone(true)
        } catch (err) {
          setError(String(err.message || err))
        } finally {
          setBusy(false)
        }
      }

      const input = (key, label, auto) => h('label', { style: { display: 'block', flex: '1 1 160px', minWidth: 0 } },
        h('div', { style: { fontSize: 12, opacity: 0.75, marginBottom: 3 } }, label),
        h('input', {
          type: 'password', value: form[key], onChange: set(key), autoComplete: auto,
          style: { width: '100%', boxSizing: 'border-box', border: line, borderRadius: 6, padding: '6px 8px', background: 'transparent', color: 'inherit', fontSize: 13 },
        }))

      return h('div', { style: S.card },
        h('div', { style: S.spread },
          h('div', null,
            h('span', { style: S.h2 }, t('账号', 'Account')),
            h('span', { style: { ...S.muted, marginLeft: 10 } }, t('管理员：', 'Admin: '), h('span', { style: S.code }, health?.admin || '—'))),
          open ? null : h('button', { type: 'button', style: S.btn(), onClick: () => { setOpen(true); setDone(false) } }, t('修改密码', 'Change password'))),
        done ? h('div', { style: S.note }, t('密码已修改。这台设备保持登录；其他设备（包括手机）上的登录已失效，需要用新密码重新登录。',
          'Password changed. This device stays signed in; every other device (phones included) is signed out and needs the new password.')) : null,
        open
          ? h('form', { onSubmit: submit, style: { marginTop: 8 } },
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10 } },
              input('current', t('当前密码', 'Current password'), 'current-password'),
              input('next', t('新密码（至少 12 位）', 'New password (12+ characters)'), 'new-password'),
              input('confirm', t('确认新密码', 'Confirm new password'), 'new-password')),
            h('div', { style: { ...S.muted, fontSize: 12, marginTop: 6 } },
              t('修改后，其他设备上的登录会全部失效。忘了当前密码：在服务器上执行 sudo dsh-vps reset-admin 重新设置。',
                'Changing it signs out every other device. Forgot the current password? Run sudo dsh-vps reset-admin on the server.')),
            error ? h('div', { style: S.err }, error) : null,
            h('div', { style: { ...S.row, marginTop: 10 } },
              h('button', { type: 'submit', style: S.btn('primary', busy), disabled: busy }, busy ? t('保存中…', 'Saving…') : t('保存新密码', 'Save new password')),
              h('button', { type: 'button', style: S.btn(), onClick: close }, t('取消', 'Cancel'))))
          : null)
    }

    function CommandsCard() {
      const rows = [
        ['sudo dsh-vps status', t('服务状态、版本、健康检查', 'services, versions and health')],
        ['sudo dsh-vps backup', t('备份 DSH 数据与网关配置（保留最近 3 份）', 'back up DSH data and gateway config (keeps the last 3)')],
        ['sudo dsh-vps rollback', t('切回上一个 DSH 版本', 'switch back to the previous DSH version')],
        ['sudo dsh-vps update-gate', t('更新网关（登录页、代理）自身', 'update the gateway itself (login page, proxy)')],
        ['sudo dsh-vps reset-admin', t('忘记管理员密码时重置', 'reset a forgotten admin password')],
      ]
      return h('div', { style: S.card },
        h('div', { style: S.h2 }, t('服务器上的常用命令', 'Server commands')),
        h('div', { style: { ...S.muted, fontSize: 12 } }, t('SSH 登录服务器后执行。', 'Run these over SSH on the server.')),
        rows.map(([cmd, note]) => h(CopyLine, { key: cmd, text: cmd, note })))
    }

    // ——————————————————————— 普通 DSH：填表安装到 VPS ———————————————————————

    const INSTALL_API = '/api/dsh-vps.install'

    async function installApi(method, body) {
      const res = await fetch(INSTALL_API, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      })
      if (res.status === 404) return { unavailable: true }
      let data = {}
      try {
        data = await res.json()
      } catch {
        // 非 JSON
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      return data
    }

    function Field({ label, hint, children }) {
      return h('label', { style: { display: 'block', minWidth: 0 } },
        h('div', { style: { fontSize: 12, opacity: 0.75, marginBottom: 3 } }, label),
        children,
        hint ? h('div', { style: { ...S.muted, fontSize: 12, marginTop: 3 } }, hint) : null)
    }

    const inputStyle = {
      width: '100%', boxSizing: 'border-box', border: line, borderRadius: 6, padding: '6px 8px',
      background: 'transparent', color: 'inherit', fontSize: 13,
    }

    function ManualCommand() {
      return h('div', null,
        h(CopyLine, { text: INSTALL_CMD }),
        h('ul', { style: { margin: '8px 0 0', paddingLeft: 18 } },
          h('li', null, t('有域名（A 记录已解析到服务器）：在末尾加 ', 'With a domain pointed at the server: append '),
            h('span', { style: S.code }, '-- --domain dsh.example.com'), t('，自动签发证书。', ' for an automatic certificate.')),
          h('li', null, t('国内网络：再加 ', 'Behind the GFW: also add '), h('span', { style: S.code }, '--mirror cn'), t('。', '.')),
          h('li', null, t('需要 root 权限，并开放 80/443 端口。安装结束时会打印带一次性令牌的设置链接，打开它创建管理员账号。',
            'Needs root and open ports 80/443. It prints a setup link with a one-time token at the end; open it to create the admin account.'))))
    }

    const UNINSTALL_CMD = 'curl -fsSL https://raw.githubusercontent.com/AIcivilization/dsh-vps/main/uninstall.sh | sudo bash -s -- --yes --keep-data'

    function InstallProgress({ job, onReset }) {
      const logRef = useRef(null)
      useEffect(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
      }, [job.lines.length])
      const un = job.action === 'uninstall'
      const running = job.state === 'running'
      const where = `${job.user}@${job.host}`
      const title = running
        ? (job.phase === 'installing'
          ? (un ? t(`正在从 ${where} 卸载…`, `Uninstalling from ${where}…`) : t(`正在安装到 ${where}…`, `Installing on ${where}…`))
          : t(`正在连接 ${where}…`, `Connecting to ${where}…`))
        : job.state === 'success'
          ? (un ? t('卸载完成', 'Uninstalled') : t('安装完成', 'Installed'))
          : (un ? t('卸载未完成', 'Uninstall did not finish') : t('安装未完成', 'Install did not finish'))
      return h('div', null,
        h('div', { style: S.spread },
          h('div', { style: S.h2 }, title),
          h('span', { style: S.badge(running ? 'accent' : job.state === 'success' ? 'ok' : 'danger') },
            running ? t('进行中', 'Running') : job.state === 'success' ? t('成功', 'Done') : t('失败', 'Failed'))),
        running ? h('div', { style: { ...S.muted, fontSize: 12 } }, un
          ? t('通常不到一分钟。可以关掉这一页，卸载在服务器上继续进行。', 'Usually under a minute. You can close this page — it keeps running on the server.')
          : t('通常需要 3–8 分钟（要下载 Node、DSH 与 Caddy）。可以关掉这一页，安装在服务器上继续进行，回来还能看到进度。',
            'Usually 3–8 minutes (Node, DSH and Caddy are downloaded). You can close this page — the install keeps running on the server and progress is here when you come back.')) : null,
        job.state === 'success' && un
          ? h('div', { style: S.note },
            h('div', null, job.keepData
              ? t('已从服务器移除 dsh-vps 的服务、网关与安装目录；DSH 数据（对话、设置）保留在 /home/dsh/.dsh，重新安装后可继续使用。',
                'The dsh-vps services, gateway and install directory were removed; DSH data (conversations, settings) is kept in /home/dsh/.dsh for a later reinstall.')
              : t('已从服务器移除 dsh-vps 的服务、网关、安装目录和 DSH 数据。', 'The dsh-vps services, gateway, install directory and DSH data were removed from the server.')),
            job.backupPath
              ? h('div', { style: { marginTop: 4 } }, t('删除前的备份：', 'Backup taken before removal: '), h('span', { style: S.code }, job.backupPath))
              : null)
          : null,
        job.state === 'success' && !un
          ? h('div', { style: S.note },
            job.setupUrl
              ? h('div', null,
                /\/setup\?token=/.test(job.setupUrl)
                  ? h('div', null, t('打开下面的链接创建管理员账号（链接含一次性令牌，用过即失效）：',
                    'Open the link below to create the admin account (it carries a one-time token):'))
                  : h('div', null, t('这台服务器之前已经装过，本次按「修复/更新」完成，账号与数据保持不变：',
                    'This server already had dsh-vps; it was repaired/updated in place, accounts and data kept:')),
                h('div', { style: { ...S.row, marginTop: 6 } },
                  h('a', { href: job.setupUrl, target: '_blank', rel: 'noreferrer', style: { ...S.btn('primary'), textDecoration: 'none' } },
                    /\/setup\?token=/.test(job.setupUrl) ? t('打开设置向导', 'Open setup wizard') : t('打开 DSH', 'Open DSH')),
                  h('span', { style: { ...S.code, wordBreak: 'break-all' } }, job.setupUrl)),
                job.domain ? null : h('div', { style: { ...S.muted, fontSize: 12, marginTop: 6 } },
                  t('未填域名时使用自签证书，浏览器会提示“不安全”，选择继续访问即可；之后可在向导里填上域名。',
                    'Without a domain a self-signed certificate is used: the browser warns, proceed anyway; you can add a domain in the wizard later.')))
              : t('已安装。SSH 登录服务器执行 sudo dsh-vps setup-url 取设置链接。', 'Installed. Run sudo dsh-vps setup-url on the server to get the setup link.'))
          : null,
        job.error ? h('div', { style: S.err }, job.error) : null,
        job.lines.length
          ? h('pre', { ref: logRef, style: { ...S.pre, marginTop: 8, maxHeight: 260, overflowY: 'auto' } }, job.lines.join('\n'))
          : null,
        running ? null : h('div', { style: { ...S.row, marginTop: 10 } },
          h('button', { type: 'button', style: S.btn(), onClick: onReset }, job.state === 'success' ? t('完成', 'Done') : t('返回修改', 'Back to the form'))))
    }

    function DeployForm({ mode, deployedHost }) {
      const [avail, setAvail] = useState('loading') // loading | yes | no
      const [job, setJob] = useState(null)
      const [showForm, setShowForm] = useState(true)
      const [form, setForm] = useState({ host: '', port: '22', user: 'root', password: '', domain: '', mirror: false, keepData: true, purgeCaddy: false })
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [manual, setManual] = useState(false)
      const timer = useRef(null)
      const un = mode === 'uninstall'
      useEffect(() => setError(null), [mode])

      const poll = useCallback(() => {
        clearInterval(timer.current)
        timer.current = setInterval(async () => {
          try {
            const r = await installApi('GET')
            if (r.job) setJob(r.job)
            if (!r.job || r.job.state !== 'running') clearInterval(timer.current)
          } catch {
            // 暂时连不上 DSH：下次再试
          }
        }, 2000)
      }, [])

      useEffect(() => {
        ;(async () => {
          try {
            const r = await installApi('GET')
            if (r.unavailable) return setAvail('no')
            setAvail('yes')
            if (r.job) {
              setJob(r.job)
              setShowForm(false)
              if (r.job.state === 'running') poll()
            }
          } catch {
            setAvail('no')
          }
        })()
        return () => clearInterval(timer.current)
      }, [poll])

      const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })

      async function submit(e) {
        e.preventDefault()
        setError(null)
        if (!form.host.trim()) return setError(t('请填写服务器 IP 或域名', 'Enter the server IP or hostname'))
        const target = `${form.user || 'root'}@${form.host.trim()}`
        const msg = un
          ? t(
            `从 ${target} 卸载 DeepSeek Harness（dsh-vps）？\n\n将停止并删除网关与 DSH 服务、安装目录 /opt/dsh-vps、Caddy 站点配置${form.purgeCaddy ? '以及 Caddy 软件包' : ''}，${form.keepData ? '保留' : '并删除'} DSH 数据（对话、设置）。\n删除前会在服务器上打包备份到 /root。此操作不可撤销。`,
            `Uninstall DeepSeek Harness (dsh-vps) from ${target}?\n\nThis stops and removes the gateway and DSH services, /opt/dsh-vps and the Caddy site config${form.purgeCaddy ? ' plus the Caddy package' : ''}, and ${form.keepData ? 'keeps' : 'deletes'} DSH data (conversations, settings).\nA backup is written to /root on the server first. This cannot be undone.`)
          : t(
            `在 ${target} 上安装 DeepSeek Harness（dsh-vps）？\n\n会安装 Node.js、DSH、Caddy 并创建系统服务，占用 80/443 端口。建议用一台新的或专用的服务器。`,
            `Install DeepSeek Harness (dsh-vps) on ${target}?\n\nThis installs Node.js, DSH and Caddy, creates system services and uses ports 80/443. A fresh or dedicated server is recommended.`)
        if (!window.confirm(msg)) return
        setBusy(true)
        try {
          const r = await installApi('POST', { ...form, action: mode, port: Number(form.port) || 22 })
          setForm((f) => ({ ...f, password: '' })) // 密码不在页面里多留
          setJob(r.job)
          setShowForm(false)
          poll()
        } catch (err) {
          setError(String(err.message || err))
        } finally {
          setBusy(false)
        }
      }

      if (avail === 'loading') return h('div', { style: S.muted }, t('读取中…', 'Loading…'))
      if (avail === 'no') return h(ManualCommand)
      if (!showForm && job) return h(InstallProgress, { job, onReset: () => { setShowForm(true); setError(null) } })

      return h('form', { onSubmit: submit },
        un && deployedHost
          ? h('div', { style: { ...S.note, marginTop: 0, marginBottom: 10 } }, t(
            `如果要卸载的就是当前这台（${deployedHost}），卸载一开始这个页面就会断开——卸载仍会在服务器上完成，结果用 SSH 登录查看。`,
            `If you are uninstalling this very server (${deployedHost}), this page disconnects as soon as it starts — the uninstall still completes on the server; check the result over SSH.`))
          : null,
        // 窄窗口（小屏、Windows 上缩小的 DSH 窗口）自动变成一行一个：flex 换行而不是固定两栏
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 12 } },
          h('div', { style: { flex: '2 1 220px', minWidth: 0 } },
            h(Field, { label: t('服务器 IP 或域名', 'Server IP or hostname'), hint: t('你买的 VPS 的公网地址', 'The public address of your VPS') },
              h('input', { style: inputStyle, value: form.host, onChange: set('host'), placeholder: '1.2.3.4', autoComplete: 'off', spellCheck: false }))),
          h('div', { style: { flex: '1 1 100px', minWidth: 0 } },
            h(Field, { label: t('SSH 端口', 'SSH port') },
              h('input', { style: inputStyle, value: form.port, onChange: set('port'), inputMode: 'numeric' })))),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 12 } },
          h('div', { style: { flex: '1 1 200px', minWidth: 0 } },
            h(Field, { label: t('用户名', 'Username'), hint: t('建议用 root；其他用户需要免密 sudo', 'root recommended; other users need passwordless sudo') },
              h('input', { style: inputStyle, value: form.user, onChange: set('user'), autoComplete: 'off', spellCheck: false }))),
          h('div', { style: { flex: '1 1 200px', minWidth: 0 } },
            h(Field, { label: t('密码', 'Password'), hint: t('只用这一次，不保存；留空则用本机已有的 SSH 密钥', 'Used once, never stored; leave empty to use your existing SSH key') },
              h('input', { style: inputStyle, type: 'password', value: form.password, onChange: set('password'), placeholder: t('服务器的登录密码', 'server login password'), autoComplete: 'new-password' })))),
        un
          ? h('div', null,
            h('label', { style: { ...S.check, marginTop: 12 } },
              h('input', { type: 'checkbox', checked: form.keepData, onChange: set('keepData'), style: S.checkbox }),
              h('span', null, t('保留 DSH 数据（对话、设置、插件，位于 /home/dsh/.dsh），以后重装可继续使用', 'Keep DSH data (conversations, settings, plugins in /home/dsh/.dsh) for a later reinstall'))),
            h('label', { style: { ...S.check, marginTop: 6 } },
              h('input', { type: 'checkbox', checked: form.purgeCaddy, onChange: set('purgeCaddy'), style: S.checkbox }),
              h('span', null, t('连同 Caddy 软件包一起移除（服务器上还有别的网站在用 Caddy 时不要勾）', 'Also remove the Caddy package (leave unchecked if other sites on the server use Caddy)'))))
          : h('div', null,
            h('div', { style: { marginTop: 12 } },
              h(Field, { label: t('访问域名（可选）', 'Domain (optional)'), hint: t('已把 A 记录解析到这台服务器的域名，填了自动签发 HTTPS 证书；不填先用 IP + 自签证书，之后可在向导里补填', 'A domain whose A record points at this server gets an automatic HTTPS certificate; leave empty to start with the IP and a self-signed certificate') },
                h('input', { style: inputStyle, value: form.domain, onChange: set('domain'), placeholder: 'dsh.example.com', autoComplete: 'off', spellCheck: false }))),
            h('label', { style: { ...S.check, marginTop: 10 } },
              h('input', { type: 'checkbox', checked: form.mirror, onChange: set('mirror'), style: S.checkbox }),
              h('span', null, t('服务器在国内（Node 与 DSH 从 npmmirror 下载）', 'Server is in mainland China (download Node and DSH from npmmirror)')))),
        error ? h('div', { style: S.err }, error) : null,
        h('div', { style: { ...S.row, marginTop: 12 } },
          h('button', {
            type: 'submit',
            style: un ? { ...S.btn(null, busy), borderColor: T.danger, color: T.danger } : S.btn('primary', busy),
            disabled: busy,
          }, busy ? t('连接中…', 'Connecting…') : un ? t('从这台 VPS 卸载', 'Uninstall from this VPS') : t('安装到这台 VPS', 'Install on this VPS')),
          h('button', { type: 'button', style: { ...S.btn(), border: 'none', opacity: 0.75 }, onClick: () => setManual(!manual) },
            manual ? t('收起手动命令', 'Hide manual command') : t('想自己在服务器上执行？', 'Prefer to run it yourself?'))),
        manual
          ? h('div', { style: { marginTop: 8 } }, un
            ? h(CopyLine, { text: UNINSTALL_CMD, note: t('去掉 --keep-data 则连 DSH 数据一起删除；加 --purge-caddy 连 Caddy 一起移除', 'Drop --keep-data to delete DSH data too; add --purge-caddy to remove Caddy as well') })
            : h(ManualCommand))
          : null)
    }

    function Tabs({ tabs, value, onChange }) {
      return h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4, borderBottom: line, marginBottom: 12 } },
        tabs.map(([key, label, danger]) => h('button', {
          key,
          type: 'button',
          onClick: () => onChange(key),
          style: {
            ...S.btn(), border: 'none', borderRadius: 0, padding: '6px 14px',
            borderBottom: value === key ? `2px solid ${danger ? T.danger : T.accent}` : '2px solid transparent',
            opacity: value === key ? 1 : 0.6, fontWeight: value === key ? 600 : 400,
          },
        }, label)))
    }

    function InstallIntro({ deployed }) {
      return h('div', { style: { marginBottom: 12 } }, t(
        `填好一台 Ubuntu 22.04+ / Debian 12+ 服务器的登录信息，点「安装到这台 VPS」，就会在上面装好带登录页、自动 HTTPS 的原版 DSH。之后在任何地方用浏览器访问：设置、API Key、插件市场都能正常用，DSH 出新版本时在那边的「设置 → VPS 部署」里一键升级。${deployed ? '这里的安装是从当前这台服务器经 SSH 装到另一台服务器。' : ''}`,
        `Enter the login details of an Ubuntu 22.04+ / Debian 12+ server and click "Install on this VPS" to set up stock DSH there behind a login page with automatic HTTPS. Then use it from any browser — settings, API keys and the plugin market all work, and new DSH releases upgrade with one click under Settings → VPS Deploy over there.${deployed ? ' The install runs over SSH from this server to the other one.' : ''}`))
    }

    function UninstallIntro() {
      return h('div', { style: { marginBottom: 12 } }, t(
        '从服务器上移除 dsh-vps 部署的 DSH：网关、DSH 服务、安装目录与 Caddy 站点配置。删除前自动打包备份到服务器的 /root；默认保留 DSH 数据（对话、设置），以后重装可继续使用。',
        'Removes a dsh-vps deployment from a server: the gateway, DSH services, install directory and Caddy site config. A backup is written to /root on the server first; DSH data (conversations, settings) is kept by default for a later reinstall.'))
    }

    // ——————————————————————— 设置页 ———————————————————————

    function SettingsSection() {
      useLocaleRevision() // DSH 里切换语言：整页随之重渲染
      const [where, setWhere] = useState('loading') // loading | deployed | standalone
      const [tab, setTab] = useState(null)
      const [info, setInfo] = useState(null)
      const [health, setHealth] = useState(null)

      useEffect(() => {
        let alive = true
        ;(async () => {
          const u = await gateGet('/gate/update')
          if (!alive) return
          if (!u || !('current' in u)) {
            setWhere('standalone')
            setTab('install')
            return
          }
          setInfo(u)
          setWhere('deployed')
          setTab('status')
          const hh = await gateGet('/gate/health')
          if (alive) setHealth(hh)
        })()
        return () => {
          alive = false
        }
      }, [])

      if (where === 'loading') return h('div', { style: { ...S.root, ...S.muted } }, t('读取中…', 'Loading…'))
      const deployed = where === 'deployed'
      const host = health?.dsh?.trustedHost || (typeof window !== 'undefined' ? window.location.host : '')
      const tabs = [
        ...(deployed ? [['status', t('本机状态', 'This server')]] : []),
        ['install', t('安装到 VPS', 'Install on a VPS')],
        ['uninstall', t('从 VPS 卸载', 'Uninstall from a VPS'), true],
      ]
      return h('div', { style: S.root },
        // 一句话说明当前这个 DSH 在哪里运行：两边的页签不同，原因在这里
        h('div', { style: { ...S.note, marginTop: 0, marginBottom: 12 } }, deployed
          ? t(`当前这个 DSH 运行在由 dsh-vps 部署的服务器上（${host}）。「本机状态」管理这台服务器；也可以从这里把 DSH 装到另一台 VPS，或从某台 VPS 上卸载。`,
            `This DSH runs on a server deployed by dsh-vps (${host}). "This server" manages it; you can also install DSH on another VPS from here, or uninstall it from one.`)
          : t('当前是在你自己电脑上运行的 DSH。可以把 DSH 装到你的 VPS 上，或从某台 VPS 上卸载。',
            'This DSH runs on your own computer. Install DSH on your VPS from here, or uninstall it from one.')),
        h(Tabs, { tabs, value: tab, onChange: setTab }),
        tab === 'status'
          ? h('div', null,
            h(VersionCard, { info, reload: setInfo }),
            h(HomeScreenCard, { health }),
            h(GatewayCard, { health }),
            h(AccountCard, { health }),
            h(CommandsCard))
          : h('div', { style: S.card },
            tab === 'uninstall' ? h(UninstallIntro) : h(InstallIntro, { deployed }),
            h(DeployForm, { mode: tab === 'uninstall' ? 'uninstall' : 'install', deployedHost: deployed ? host : null }),
            h('div', { style: { marginTop: 10 } },
              h('a', { href: REPO, target: '_blank', rel: 'noreferrer', style: { color: T.accent } }, t('完整说明（GitHub）', 'Full guide (GitHub)')))))
    }

    // ——————————————————————— 注册 ———————————————————————

    const name = 'dsh-vps-client'
    const inject = ['slots', 'locale']

    function apply(ctx) {
      try {
        localeSvc = ctx.locale ?? null
      } catch {
        localeSvc = null
      }
      try {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'dsh-vps', order: 35, label: () => t('VPS 部署', 'VPS Deploy') }, SettingsSection))
      } catch (error) {
        console.warn('[dsh-vps] 设置页注册失败', error)
      }
    }

    module.exports = { name, inject, apply, __test: { ago, duration, gateGet } }
    return module.exports
  },
})
