// Copyright IBM Corp. 2016,2019. All Rights Reserved.
// Node module: strong-soap
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT


const xmlBuilder = require('xmlbuilder');
const sax = require('sax');
const stream = require('stream');
const assert = require('assert');
const selectn = require('selectn');
const debug = require('debug')('strong-soap:xmlhandler');
const descriptor = require('./xsd/descriptor');

const { ElementDescriptor } = descriptor;
const { AttributeDescriptor } = descriptor;
const { TypeDescriptor } = descriptor;
const QName = require('./qname');
const helper = require('./helper');
const NamespaceContext = require('./nscontext');


class XMLHandler {
  constructor(schemas, options) {
    this.schemas = schemas || {};
    this.options = options || {};
    this.options.valueKey = this.options.valueKey || '$value';
    this.options.xmlKey = this.options.xmlKey || '$xml';
    this.options.attributesKey = this.options.attributesKey || '$attributes';
    this.options.xsiTypeKey = this.options.xsiTypeKey || '$xsiType';
  }

  jsonToXml(node, nsContext, descriptor, val) {
    if (node == null) {
      node = xmlBuilder.begin(
        { version: '1.0', encoding: 'UTF-8', standalone: true }
      );
    }
    if (nsContext == null) {
      nsContext = new NamespaceContext();
    }

    let name;
    let nameSpaceContextCreated = false;
    if (descriptor instanceof AttributeDescriptor) {
      val = toXmlDateOrTime(descriptor, val);
      name = descriptor.qname.name;
      if (descriptor.form === 'unqualified') {
        node.attribute(name, val);
      } else if (descriptor.qname) {
        const mapping = declareNamespace(nsContext, node, descriptor.qname.prefix,
          descriptor.qname.nsURI);
        const prefix = mapping ? mapping.prefix : descriptor.qname.prefix;
        const attrName = prefix ? prefix + ':' + name : name;
        node.attribute(attrName, val);
      }
      return node;
    }

    if (descriptor instanceof ElementDescriptor) {
      name = descriptor.qname.name;
      const { isSimple } = descriptor;
      let attrs = null;
      if (descriptor.isMany) {
        if (Array.isArray(val)) {
          for (let i = 0, n = val.length; i < n; i++) {
            node = this.jsonToXml(node, nsContext, descriptor, val[i]);
          }
          return node;
        }
      }
      if (val !== null && typeof val === 'object') {
        // check for $attributes field
        if (typeof val[this.options.attributesKey] !== 'undefined') {
          attrs = val[this.options.attributesKey];
        }
        // add any $value field as xml element value
        if (typeof val[this.options.valueKey] !== 'undefined') {
          val = val[this.options.valueKey];
        }
      }
      let element;
      let elementName;
      let xmlns;
      if (descriptor.form === 'unqualified') {
        elementName = name;
        nsContext.pushContext();
        nameSpaceContextCreated = true;
      } else if (descriptor.qname) {
        nsContext.pushContext();
        nameSpaceContextCreated = true;
        // get the mapping for the namespace uri
        let mapping = nsContext.getPrefixMapping(descriptor.qname.nsURI);
        let newlyDeclared = false;
        // if namespace not declared, declare it
        if (mapping === null || mapping.declared === false) {
          newlyDeclared = true;
          mapping = declareNamespace(nsContext, null,
            descriptor.qname.prefix, descriptor.qname.nsURI);
        }
        // add the element to a parent node
        const prefix = mapping ? mapping.prefix : descriptor.qname.prefix;
        elementName = prefix ? prefix + ':' + name : name;
        // if namespace is newly declared add the xmlns attribute
        if (newlyDeclared) {
          xmlns = prefix ? 'xmlns:' + prefix : 'xmlns';
        }
      }

      // add the element to a parent node
      if (isSimple && /<!\[CDATA/.test(val)) {
        element = node.element(elementName);
        val = val.replace('<![CDATA[', '');
        val = val.replace(']]>', '');
        element.cdata(val);
      } else if (isSimple && typeof val !== 'undefined' && val !== null
        && typeof val[this.options.xmlKey] !== 'undefined') {
        val = val[this.options.xmlKey];
        element = node.element(elementName);
        val = toXmlDateOrTime(descriptor, val);
        element.raw(val);
      } else {
        // Enforce the type restrictions if configured for such
        if (this.options.enforceRestrictions && descriptor.type) {
          const schema = this.schemas[descriptor.type.nsURI];
          if (schema) {
            let type = schema.simpleTypes[descriptor.type.name];
            // if type not available in global schema
            // , check if it is embedded in descriptor as an anonymous type
            if (!type && descriptor.type.anonymous) {
              type = descriptor.type.anonymous;
            }
            if (type) {
              const { restriction } = type;
              if (restriction) {
                val = restriction.enforce(val);
              }
            }
          }
        }
        val = toXmlDateOrTime(descriptor, val);
        element = isSimple ? node.element(elementName, val) : node.element(elementName);
      }

      if (xmlns && descriptor.qname.nsURI) {
        if (typeof element.attribute === 'function') {
          element.attribute(xmlns, descriptor.qname.nsURI);
        }
      }

      if (val == null) {
        if (descriptor.isNillable) {
          // Set xsi:nil = true
          declareNamespace(nsContext, element, 'xsi', helper.namespaces.xsi);
          if (typeof element.attribute === 'function') {
            element.attribute('xsi:nil', true);
          }
        }
      }

      if (isSimple) {
        if (attrs !== null) {
          // add each field in $attributes object as xml element attribute
          if (typeof attrs === 'object') {
            // add $attributes. Attribute can be an attribute defined in XSD or an xsi:type
            this.addAttributes(element, nsContext, descriptor, val, attrs);
          }
        }
        if (nameSpaceContextCreated) {
          nsContext.popContext();
        }
        return node;
      } if (val != null) {
        const attrs = val[this.options.attributesKey];
        if (typeof attrs === 'object') {
          for (const p in attrs) {
            const child = attrs[p];
            if (p === this.options.xsiTypeKey) {
              if (descriptor instanceof ElementDescriptor) {
                if (descriptor.refOriginal) {
                  if (descriptor.refOriginal.typeDescriptor) {
                    if (descriptor.refOriginal.typeDescriptor.inheritance) {
                      const extension = descriptor.refOriginal.typeDescriptor.inheritance[child.type];
                      if (extension) {
                        descriptor.elements = descriptor.elements.concat(extension.elements);
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
      // val is not an object - simple or date types
      if (val != null && (typeof val !== 'object' || val instanceof Date)) {
        // for adding a field value nsContext.popContext() shouldnt be called
        val = toXmlDateOrTime(descriptor, val);
        element.text(val);
        // add $attributes. Attribute can be an attribute defined in XSD or an xsi:type.
        // e.g of xsi:type <name xmlns=".." xmlns:xsi="..." xmlns:ns="..." xsi:type="ns:string">some name</name>
        if (attrs != null) {
          this.addAttributes(element, nsContext, descriptor, val, attrs);
        }
        if (nameSpaceContextCreated) {
          nsContext.popContext();
        }
        return node;
      }

      this.mapObject(element, nsContext, descriptor, val, attrs);
      if (nameSpaceContextCreated) {
        nsContext.popContext();
      }
      return node;
    }

    if (descriptor == null || descriptor === undefined || descriptor instanceof TypeDescriptor) {
      this.mapObject(node, nsContext, descriptor, val);
      return node;
    }

    return node;
  }

  /**
   * Check if the attributes have xsi:type and return the xsi type descriptor if exists
   * @param {*} descriptor The current descriptor
   * @param {*} attrs An object of attribute values
   */
  getXsiType(descriptor, attrs) {
    let xsiTypeDescriptor;
    if (attrs != null && typeof attrs === 'object') {
      for (const p in attrs) {
        const child = attrs[p];
        // if field is $xsiType add xsi:type attribute
        if (p === this.options.xsiTypeKey) {
          let xsiType;
          if (typeof child === 'object' && typeof child.type !== 'undefined') {
            // $xsiType has two fields - type, xmlns
            xsiType = QName.parse(child.type, child.xmlns);
          } else {
            xsiType = QName.parse(child);
          }
          const schema = this.schemas[xsiType.nsURI];
          if (schema) {
            const xsiTypeInfo = schema.complexTypes[xsiType.name]
              || schema.simpleTypes[xsiType.name];
            // The type might not be described
            // describe() takes wsdl definitions
            xsiTypeDescriptor = xsiTypeInfo && xsiTypeInfo.describe({ schemas: this.schemas });
          }
          break;
        }
      }
    }
    return xsiTypeDescriptor;
  }

  _sortKeys(val, elementOrder) {
    function compare(n1, n2, order) {
      let i1 = order.indexOf(n1);
      if (i1 === -1) i1 = order.length;
      let i2 = order.indexOf(n2);
      if (i2 === -1) i2 = order.length;
      return i1 - i2;
    }
    const keys = Object.keys(val);
    const names = [].concat(keys).sort((n1, n2) => {
      let result = compare(n1, n2, elementOrder);
      if (result === 0) {
        result = compare(n1, n2, keys);
      }
      return result;
    });
    return names;
  }

  /**
   * Map a JSON object into an XML type
   * @param {XMLElement} node The root node
   * @param {NamespaceContext} nsContext Namespace context
   * @param {TypeDescriptor|ElementDescriptor} descriptor
   * @param {Object} val
   * @returns {*}
   */
  mapObject(node, nsContext, descriptor, val, attrs) {
    if (val == null) return node;
    if (typeof val !== 'object' || (val instanceof Date)) {
      val = toXmlDateOrTime(descriptor, val);
      node.text(val);
      return node;
    }

    // First try to see if a subtype should be used
    const xsiType = this.getXsiType(descriptor, attrs);
    descriptor = xsiType || descriptor;

    const elements = {}; const
      attributes = {};
    const elementOrder = [];
    if (descriptor != null) {
      for (let i = 0, n = descriptor.elements.length; i < n; i++) {
        const elementDescriptor = descriptor.elements[i];
        const elementName = elementDescriptor.qname.name;
        elements[elementName] = elementDescriptor;
        elementOrder.push(elementName);
      }
    }

    if (descriptor != null) {
      for (const a in descriptor.attributes) {
        const attributeDescriptor = descriptor.attributes[a];
        const attributeName = attributeDescriptor.qname.name;
        attributes[attributeName] = attributeDescriptor;
      }
    }

    // handle later if value is an array
    if (!Array.isArray(val)) {
      const names = this._sortKeys(val, elementOrder);
      for (const p of names) {
        if (p === this.options.attributesKey) { continue; }
	      const child = val[p];
	      let childDescriptor = elements[p] || attributes[p];
	      if (childDescriptor == null) {
	        if (this.options.ignoreUnknownProperties) { continue; } else {
            childDescriptor = new ElementDescriptor(
              QName.parse(p), null, 'unqualified', Array.isArray(child)
            );
          }
        }
        if (childDescriptor) {
          this.jsonToXml(node, nsContext, childDescriptor, child);
        }
	    }
    }

    this.addAttributes(node, nsContext, descriptor, val, attrs);

    return node;
  }

  addAttributes(node, nsContext, descriptor, val, attrs) {
    const attrDescriptors = (descriptor && descriptor.attributes) || [];
    const attributes = {};
    for (let i = 0; i < attrDescriptors.length; i++) {
      const { qname } = attrDescriptors[i];
      attributes[qname.name] = attrDescriptors[i];
    }
    if (attrs != null && typeof attrs === 'object') {
      for (const p in attrs) {
        const child = attrs[p];
        // if field is $xsiType add xsi:type attribute
        if (p === this.options.xsiTypeKey) {
          let xsiType;
          if (typeof child === 'object' && typeof child.type !== 'undefined') {
            // $xsiType has two fields - type, xmlns
            xsiType = QName.parse(child.type, child.xmlns);
          } else {
            xsiType = QName.parse(child);
          }
          declareNamespace(nsContext, node, 'xsi', helper.namespaces.xsi);
          const mapping = declareNamespace(nsContext, node, xsiType.prefix,
            xsiType.nsURI);
          const prefix = mapping ? mapping.prefix : xsiType.prefix;
          node.attribute('xsi:type', prefix ? prefix + ':' + xsiType.name
            : xsiType.name);
          continue;
        }
        let childDescriptor = attributes[p];
        if (childDescriptor == null) {
          if (this.options.ignoreUnknownProperties) continue;
          else {
            childDescriptor = new AttributeDescriptor(QName.parse(p), null, 'unqualified');
          }
        }
        this.jsonToXml(node, nsContext, childDescriptor, child);
      }
    }
  }

  static createSOAPEnvelope(prefix, nsURI) {
    prefix = prefix || 'soap';
    const doc = xmlBuilder.create(prefix + ':Envelope',
      { version: '1.0', encoding: 'UTF-8', standalone: true });
    nsURI = nsURI || 'http://schemas.xmlsoap.org/soap/envelope/';
    doc.attribute('xmlns:' + prefix,
      nsURI);
    const header = doc.element(prefix + ':Header');
    const body = doc.element(prefix + ':Body');
    return {
      body: body,
      header: header,
      doc: doc
    };
  }

  static createSOAPEnvelopeDescriptor(prefix, nsURI, parameterDescriptor) {
    prefix = prefix || 'soap';
    nsURI = nsURI || 'http://schemas.xmlsoap.org/soap/envelope/';
    const descriptor = new TypeDescriptor();

    const envelopeDescriptor = new ElementDescriptor(
      new QName(nsURI, 'Envelope', prefix), null, 'qualified', false
    );
    descriptor.addElement(envelopeDescriptor);

    const headerDescriptor = new ElementDescriptor(
      new QName(nsURI, 'Header', prefix), null, 'qualified', false
    );

    const bodyDescriptor = new ElementDescriptor(
      new QName(nsURI, 'Body', prefix), null, 'qualified', false
    );

    envelopeDescriptor.addElement(headerDescriptor);
    envelopeDescriptor.addElement(bodyDescriptor);

    if (parameterDescriptor && parameterDescriptor.body) {
      bodyDescriptor.add(parameterDescriptor.body);
    }

    if (parameterDescriptor && parameterDescriptor.headers) {
      bodyDescriptor.add(parameterDescriptor.headers);
    }

    if (parameterDescriptor && parameterDescriptor.faults) {
      const xsdStr = new QName(helper.namespaces.xsd, 'string', 'xsd');
      const faultDescriptor = new ElementDescriptor(
        new QName(nsURI, 'Fault', prefix), null, 'qualified', false
      );
      faultDescriptor.addElement(
        new ElementDescriptor(nsURI, 'faultcode', xsdStr, 'qualified', false)
      );
      faultDescriptor.addElement(
        new ElementDescriptor(nsURI, 'faultstring', xsdStr, 'qualified', false)
      );
      faultDescriptor.addElement(
        new ElementDescriptor(nsURI, 'faultactor', xsdStr, 'qualified', false)
      );
      const detailDescriptor = new ElementDescriptor(nsURI, 'detail', null, 'qualified', false);
      faultDescriptor.addElement(detailDescriptor);

      for (const f in parameterDescriptor.faults) {
        detailDescriptor.add(parameterDescriptor.faults[f]);
      }
    }

    return descriptor;
  }

  /**
   * Parse XML string or stream into the XMLBuilder tree
   * @param root The root node
   * @param xml XML string or stream
   * @param cb
   * @returns {*}
   */
  static parseXml(root, xml, cb) {
    let parser;
    let stringMode = true;
    debug('XMLHandler parseXML. root: %j xml: %j', root, xml);
    if (typeof xml === 'string') {
      stringMode = true;
      parser = sax.parser(true, { opt: { xmlns: true } });
    } else if (xml instanceof stream.Readable) {
      stringMode = false;
      parser = sax.createStream(true, { opt: { xmlns: true } });
    }
    if (!root) {
      root = xmlBuilder.begin();
    }
    let current = root;
    const stack = [root];

    parser.onerror = function(e) {
      // an error happened.
      if (cb) process.nextTick(cb);
    };

    parser.ontext = function(text) {
      // got some text.  t is the string of text.
      if (current.isDocument) return;
      text = text.trim();
      if (text) {
        current.text(text);
      }
    };

    parser.oncdata = function(text) {
      if (current.isDocument) return;
      text = text.trim();
      if (text) {
        current.cdata(text);
      }
    };

    parser.onopentag = function(node) {
      // opened a tag.  node has "name" and "attributes"
      const element = current.element(node.name);
      if (node.attributes) {
        element.attribute(node.attributes);
      }
      stack.push(element);
      current = element;
    };

    parser.onclosetag = function(nsName) {
      const top = stack.pop();
      assert(top === current);
      assert(top.name === nsName);
      current = stack[stack.length - 1];
    };

    parser.onend = function() {
      if (cb) {
        process.nextTick(() => {
        // parser stream is done, and ready to have more stuff written to it.
          cb && cb(null, root);
        });
      }
    };

    if (stringMode) {
      parser.write(xml).close();
    } else {
      xml.pipe(parser);
    }
    return root;
  }

  _processText(top, val) {
    // The parent element has xsi:nil = true
    if (top.object === null) return;
    // Top object has no other elements or attributes
    if (top.object === undefined) {
      top.object = val;
    } else if (top.object.constructor === Object) {
      // Top object already has attributes or elements
      const value = top.object[this.options.valueKey];
      if (value !== undefined) {
        top.object[this.options.valueKey] = value + val;
      } else {
        top.object[this.options.valueKey] = val;
      }
    } else {
      // Top object is other simple types, such as string or date
      top.object += val;
    }
  }

  xmlToJson(nsContext, xml, descriptor) {
    const self = this;
    const p = sax.parser(true);
    nsContext = nsContext || new NamespaceContext();
    const root = {};
    const refs = {}; let
      id; // {id: {hrefs:[], obj:}, ...}
    const stack = [{ name: null, object: root, descriptor: descriptor }];
    const { options } = this;

    p.onopentag = function(node) {
      nsContext.pushContext();
      const top = stack[stack.length - 1];
      const { descriptor } = top;
      const nsName = node.name;
      const attrs = node.attributes;
      let obj;
      let elementAttributes = null;

      // Register namespaces 1st
      for (const a in attrs) {
        if (/^xmlns:|^xmlns$/.test(a)) {
          const prefix = (a === 'xmlns') ? '' : a.substring(6);
          nsContext.addNamespace(prefix, attrs[a]);
        }
      }

      // Handle regular attributes
      for (const a in attrs) {
        if (/^xmlns:|^xmlns$/.test(a)) continue;
        const qname = QName.parse(a);
        let isXsiType = false;
        let xsiType = null;
        let xsiXmlns = null;
        if (nsContext.getNamespaceURI(qname.prefix) === helper.namespaces.xsi) {
          // Handle xsi:*
          if (qname.name == 'nil') {
            // xsi:nil
            if (attrs[a] === 'true') {
              obj = null;
            }
            continue;
          } else if (qname.name === 'type') {
            // xsi:type
            isXsiType = true;
            xsiType = attrs[a];
            xsiType = QName.parse(xsiType);
            attrs[a] = xsiType.name;
            if (xsiType.prefix) {
              xsiXmlns = nsContext.getNamespaceURI(xsiType.prefix);
            }
          }
        }
        const attrName = qname.name;
        elementAttributes = elementAttributes || {};
        const attrDescriptor = descriptor && descriptor.findAttribute(qname.name);
        const attrValue = parseValue(attrs[a], attrDescriptor);
        // if element attribute is xsi:type add $xsiType field
        if (isXsiType) {
          // $xsiType object has two fields - type and xmlns
          xsiType = {};
          xsiType.type = attrs[a];
          xsiType.xmlns = xsiXmlns;
          elementAttributes[options.xsiTypeKey] = xsiType;
        } else {
          elementAttributes[attrName] = attrs[a];
        }
      }

      if (elementAttributes) {
        obj = {};
        obj[self.options.attributesKey] = elementAttributes;
      }

      const elementQName = QName.parse(nsName);
      elementQName.nsURI = nsContext.getNamespaceURI(elementQName.prefix);

      // SOAP href (#id)
      if (attrs.href != null) {
        id = attrs.href.substr(1);
        if (refs[id] === undefined) {
          refs[id] = { hrefs: [], object: null };
        }
        refs[id].hrefs.push({
          parent: top.object, key: elementQName.name, object: obj
        });
      }
      id = attrs.id;
      if (id != null) {
        if (refs[id] === undefined) { refs[id] = { hrefs: [], object: null }; }
      }

      stack.push({
        name: elementQName.name,
        object: obj,
        descriptor: descriptor && descriptor.findElement(elementQName.name),
        id: attrs.id
      });
    };

    p.onclosetag = function(nsName) {
      const elementName = QName.parse(nsName).name;
      nsContext.popContext();
      const current = stack.pop();
      const top = stack[stack.length - 1];
      if (top.object === undefined) {
        top.object = {};
      }
      if (top.object !== null) {
        if (typeof top.object === 'object' && elementName in top.object) {
          // The element exist already, let's create an array
          const val = top.object[elementName];
          if (Array.isArray(val)) {
            // Add to the existing array
            val.push(current.object);
          } else {
            // Convert the element value to an array
            top.object[elementName] = [val, current.object];
          }
        } else if (current.descriptor && current.descriptor.isMany) {
          top.object[elementName] = [current.object];
        } else {
          top.object[elementName] = current.object;
        }
      }
      if (current.id != null) {
        refs[current.id].object = current.object;
      }
    };

    p.oncdata = function(text) {
      text = text && text.trim();
      if (!text.length) { return; }

      if (/<\?xml[\s\S]+\?>/.test(text)) {
        text = self.xmlToJson(null, text);
      }
      // add contents of CDATA to the xml output as a text
      p.handleJsonObject(text);
    };

    p.handleJsonObject = function(text) {
      const top = stack[stack.length - 1];
      self._processText(top, text);
    };

    p.ontext = function(text) {
      text = text && text.trim();
      if (!text.length) { return; }

      const top = stack[stack.length - 1];
      const { descriptor } = top;
      const value = parseValue(text, descriptor);
      self._processText(top, value);
    };

    p.write(xml).close();

    // merge obj with href
    const merge = function(href, obj) {
      for (const j in obj) {
        if (obj.hasOwnProperty(j)) {
          href.object[j] = obj[j];
        }
      }
    };

    // MultiRef support: merge objects instead of replacing
    for (const n in refs) {
      const ref = refs[n];
      for (let i = 0; i < ref.hrefs.length; i++) {
        merge(ref.hrefs[i], ref.object);
      }
    }

    if (root.Envelope) {
      const body = root.Envelope.Body;
      if (root.Envelope.Body !== undefined && root.Envelope.Body !== null) {
        if (body.Fault !== undefined && body.Fault !== null) {
          // check if fault is soap 1.1 fault
          let errorMessage = getSoap11FaultErrorMessage(body.Fault);
          // check if fault is soap 1.2 fault
          if (errorMessage == null) {
            errorMessage = getSoap12FaultErrorMessage(body.Fault);
          }
          // couldn't process error message for neither soap 1.1 nor soap 1.2 fault. Nothing else can be done at this point. Send a generic error message.
          if (errorMessage == null) {
            errorMessage = 'Error occurred processing Fault response.';
          }
          const error = new Error(errorMessage);
          error.root = root;
          throw error;
        }
      }
      return root.Envelope;
    }
    return root;
  }
}

function getSoap11FaultErrorMessage(faultBody) {
  let errorMessage = null;
  const faultcode = selectn('faultcode.$value', faultBody)
    || selectn('faultcode', faultBody);
  if (faultcode) { // soap 1.1 fault
    errorMessage = ' ';
    // All of the soap 1.1 fault elements should contain string value except detail element which may be a complex type or plain text (string)
    if (typeof faultcode === 'string') {
      errorMessage = 'faultcode: ' + faultcode;
    }
    const faultstring = selectn('faultstring.$value', faultBody)
      || selectn('faultstring', faultBody);
    if (faultstring && (typeof faultstring === 'string')) {
      errorMessage = errorMessage + ' faultstring: ' + faultstring;
    }
    const faultactor = selectn('faultactor.$value', faultBody)
      || selectn('faultactor', faultBody);
    if (faultactor && (typeof faultactor === 'string')) {
      errorMessage = errorMessage + ' faultactor: ' + faultactor;
    }
    const detail = selectn('detail.$value', faultBody)
      || selectn('detail', faultBody);
    if (detail != null) {
      if (typeof detail === 'string') { // plain text
        errorMessage = errorMessage + ' detail: ' + detail;
      } else { // XML type defined in wsdl
        errorMessage = errorMessage + ' detail: ' + JSON.stringify(detail);
      }
    }
  }
  return errorMessage;
}

function getSoap12FaultErrorMessage(faultBody) {
  let errorMessage = null;
  const code = selectn('Code', faultBody)
    || selectn('Code', faultBody);
  if (code) {
    // soap 1.2 fault elements have child elements. Hence use JSON.stringify to formulate the error message.
    errorMessage = ' ';
    errorMessage = errorMessage + 'Code: ' + JSON.stringify(code);
    const value = selectn('Value.$value', faultBody)
      || selectn('Value', faultBody);
    if (value) {
      errorMessage = errorMessage + ' ' + 'Value: ' + JSON.stringify(value);
    }
    const subCode = selectn('Subcode.$value', faultBody)
      || selectn('Subcode', faultBody);
    if (subCode) {
      errorMessage = errorMessage + ' ' + 'Subcode: ' + JSON.stringify(subCode);
    }
    const reason = selectn('reason.$value', faultBody)
      || selectn('Reason', faultBody);
    if (reason) {
      errorMessage = errorMessage + ' ' + 'Reason: ' + JSON.stringify(reason);
    }
    const node = selectn('Node.$value', faultBody)
      || selectn('Node', faultBody);
    if (node) {
      errorMessage = errorMessage + ' ' + 'Node: ' + JSON.stringify(node);
    }
    const role = selectn('Role.$value', faultBody)
      || selectn('Role', faultBody);
    if (role) {
      errorMessage = errorMessage + ' ' + 'Role: ' + JSON.stringify(role);
    }
    const detail = selectn('Detail.$value', faultBody)
      || selectn('Detail', faultBody);
    if (detail != null) {
      if (typeof detail === 'string') { // plain text
        errorMessage = errorMessage + ' Detail: ' + detail;
      } else { // XML type defined in wsdl
        errorMessage = errorMessage + ' Detail: ' + JSON.stringify(detail);
      }
    }
  }
  return errorMessage;
}


function declareNamespace(nsContext, node, prefix, nsURI) {
  const mapping = nsContext.declareNamespace(prefix, nsURI);
  if (!mapping) {
    return false;
  } if (node) {
    if (typeof node.attribute === 'function') {
      // Some types of node such as XMLDummy does not allow attribute
      node.attribute('xmlns:' + mapping.prefix, mapping.uri);
    }
    return mapping;
  }
  return mapping;
}

function parseValue(text, descriptor) {
  if (typeof text !== 'string') return text;
  let value = text;
  const jsType = descriptor && descriptor.jsType;
  if (jsType === Date) {
    const dateText = text;
    if (dateText.length === 10) {
      value = dateText;
    } else {
      value = new Date(dateText); // assumes proper timezone config as dates without Z are assumed local.
    }
  } else if (jsType === Boolean) {
    if (text === 'true' || text === '1') {
      value = true;
    } else {
      value = false;
    }
  } else if (typeof jsType === 'function') {
    value = jsType(text);
  }
  return value;
}

function toXmlDate(date) {
  return date; // it's a validated YYYY-MM-DD string
}

function toXmlTime(date) {
  date = new Date(date);
  const isoStr = date.toISOString();
  return isoStr.split('T')[1];
}

function toXmlDateTime(date) {
  date = new Date(date);
  const isoStr = date.toISOString();
  return isoStr;
}

function toXmlDateOrTime(descriptor, val) {
  if (!descriptor || !descriptor.type || val === null) return val;
  if (descriptor.type.name === 'date') {
    val = toXmlDate(val);
  } else if (descriptor.type.name === 'time') {
    val = toXmlTime(val);
  } else if (descriptor.type.name === 'dateTime') {
    val = toXmlDateTime(val);
  }
  return val;
}

module.exports = XMLHandler;

// Exported function for testing
module.exports.parseValue = parseValue;
module.exports.toXmlDate = toXmlDate;
module.exports.toXmlTime = toXmlTime;
module.exports.toXmlDateTime = toXmlDateTime;
