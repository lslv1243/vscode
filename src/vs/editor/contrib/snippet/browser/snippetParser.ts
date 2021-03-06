/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { CharCode } from 'vs/base/common/charCode';

export enum TokenType {
	Dollar,
	Colon,
	CurlyOpen,
	CurlyClose,
	Backslash,
	Int,
	VariableName,
	Format,
	EOF
}

export interface Token {
	type: TokenType;
	pos: number;
	len: number;
}


export class Scanner {

	private static _table: { [ch: number]: TokenType } = {
		[CharCode.DollarSign]: TokenType.Dollar,
		[CharCode.Colon]: TokenType.Colon,
		[CharCode.OpenCurlyBrace]: TokenType.CurlyOpen,
		[CharCode.CloseCurlyBrace]: TokenType.CurlyClose,
		[CharCode.Backslash]: TokenType.Backslash,
	};

	static isDigitCharacter(ch: number): boolean {
		return ch >= CharCode.Digit0 && ch <= CharCode.Digit9;
	}

	static isVariableCharacter(ch: number): boolean {
		return ch === CharCode.Underline
			|| (ch >= CharCode.a && ch <= CharCode.z)
			|| (ch >= CharCode.A && ch <= CharCode.Z);
	}

	value: string;
	pos: number;

	constructor() {
		this.text('');
	}

	text(value: string) {
		this.value = value;
		this.pos = 0;
	}

	tokenText(token: Token): string {
		return this.value.substr(token.pos, token.len);
	}

	next(): Token {

		if (this.pos >= this.value.length) {
			return { type: TokenType.EOF, pos: this.pos, len: 0 };
		}

		let pos = this.pos;
		let len = 0;
		let ch = this.value.charCodeAt(pos);
		let type: TokenType;

		// static types
		type = Scanner._table[ch];
		if (typeof type === 'number') {
			this.pos += 1;
			return { type, pos, len: 1 };
		}

		// number
		if (Scanner.isDigitCharacter(ch)) {
			type = TokenType.Int;
			do {
				len += 1;
				ch = this.value.charCodeAt(pos + len);
			} while (Scanner.isDigitCharacter(ch));

			this.pos += len;
			return { type, pos, len };
		}

		// variable name
		if (Scanner.isVariableCharacter(ch)) {
			type = TokenType.VariableName;
			do {
				ch = this.value.charCodeAt(pos + (++len));
			} while (Scanner.isVariableCharacter(ch) || Scanner.isDigitCharacter(ch));

			this.pos += len;
			return { type, pos, len };
		}


		// format
		type = TokenType.Format;
		do {
			len += 1;
			ch = this.value.charCodeAt(pos + len);
		} while (
			!isNaN(ch)
			&& typeof Scanner._table[ch] === 'undefined' // not static token
			&& !Scanner.isDigitCharacter(ch) // not number
			&& !Scanner.isVariableCharacter(ch) // not variable
		);

		this.pos += len;
		return { type, pos, len };
	}
}

export abstract class Marker {
	_markerBrand: any;

	static toString(marker?: Marker[]): string {
		let result = '';
		for (const m of marker) {
			result += m.toString();
		}
		return result;
	}

	parent: Marker;

	private _children: Marker[] = [];

	set children(marker: Marker[]) {
		this._children = [];
		for (const m of marker) {
			m.parent = this;
			this._children.push(m);
		}
		// Object.freeze(this._children);
	}

	get children(): Marker[] {
		return this._children;
	}

	toString() {
		return '';
	}

	len(): number {
		return 0;
	}

	abstract clone(): Marker;
}

export class Text extends Marker {
	constructor(public string: string) {
		super();
	}
	toString() {
		return this.string;
	}
	len(): number {
		return this.string.length;
	}
	clone(): Text {
		return new Text(this.string);
	}
}

export class Placeholder extends Marker {

	static compareByIndex(a: Placeholder, b: Placeholder): number {
		if (a.index === b.index) {
			return 0;
		} else if (a.isFinalTabstop) {
			return 1;
		} else if (b.isFinalTabstop) {
			return -1;
		} else if (a.index < b.index) {
			return -1;
		} else if (a.index > b.index) {
			return 1;
		} else {
			return 0;
		}
	}

	constructor(public index: number, children: Marker[]) {
		super();
		this.children = children;
	}
	get isFinalTabstop() {
		return this.index === 0;
	}
	toString() {
		return Marker.toString(this.children);
	}
	clone(): Placeholder {
		return new Placeholder(this.index, this.children.map(child => child.clone()));
	}
}

export class Variable extends Marker {

	resolvedValue: string;

	constructor(public name: string = '', children: Marker[]) {
		super();
		this.children = children;
	}
	get isDefined(): boolean {
		return this.resolvedValue !== undefined;
	}
	len(): number {
		if (this.isDefined) {
			return this.resolvedValue.length;
		} else {
			return super.len();
		}
	}
	toString() {
		return this.isDefined ? this.resolvedValue : Marker.toString(this.children);
	}
	clone(): Variable {
		const ret = new Variable(this.name, this.children.map(child => child.clone()));
		ret.resolvedValue = this.resolvedValue;
		return ret;
	}
}
export function walk(marker: Marker[], visitor: (marker: Marker) => boolean): void {
	const stack = [...marker];
	while (stack.length > 0) {
		const marker = stack.shift();
		const recurse = visitor(marker);
		if (!recurse) {
			break;
		}
		stack.unshift(...marker.children);
	}
}

export class TextmateSnippet extends Marker {

	private _placeholders: Placeholder[];

	constructor(marker: Marker[]) {
		super();
		this.children = marker;
	}

	get placeholders(): Placeholder[] {
		if (!this._placeholders) {
			// fill in placeholders
			this._placeholders = [];
			walk(this.children, candidate => {
				if (candidate instanceof Placeholder) {
					this.placeholders.push(candidate);
				}
				return true;
			});
		}
		return this._placeholders;
	}

	offset(marker: Marker): number {
		let pos = 0;
		let found = false;
		walk(this.children, candidate => {
			if (candidate === marker) {
				found = true;
				return false;
			}
			pos += candidate.len();
			return true;
		});

		if (!found) {
			return -1;
		}
		return pos;
	}

	fullLen(marker: Marker): number {
		let ret = 0;
		walk([marker], marker => {
			ret += marker.len();
			return true;
		});
		return ret;
	}

	enclosingPlaceholders(placeholder: Placeholder): Placeholder[] {
		let ret: Placeholder[] = [];
		let { parent } = placeholder;
		while (parent) {
			if (parent instanceof Placeholder) {
				ret.push(parent);
			}
			parent = parent.parent;
		}
		return ret;
	}

	get text() {
		return Marker.toString(this.children);
	}

	resolveVariables(resolver: { resolve(name: string): string }): this {
		walk(this.children, candidate => {
			if (candidate instanceof Variable) {
				candidate.resolvedValue = resolver.resolve(candidate.name);
				if (candidate.isDefined) {
					// remove default value from resolved variable
					candidate.children = [];
				}
			}
			return true;
		});
		return this;
	}

	replace(marker: Marker, others: Marker[]): void {
		const { parent } = marker;
		const idx = parent.children.indexOf(marker);
		const newChildren = parent.children.slice(0);
		newChildren.splice(idx, 1, ...others);
		parent.children = newChildren;
		this._placeholders = undefined;
	}

	clone(): TextmateSnippet {
		return new TextmateSnippet(this.children.map(child => child.clone()));
	}
}

export class SnippetParser {

	static escape(value: string): string {
		return value.replace(/\$|}|\\/g, '\\$&');
	}

	static parse(template: string, enforceFinalTabstop?: boolean): TextmateSnippet {
		const marker = new SnippetParser().parse(template, true, enforceFinalTabstop);
		return new TextmateSnippet(marker);
	}

	private _scanner = new Scanner();
	private _token: Token;
	private _prevToken: Token;


	text(value: string): string {
		return Marker.toString(this.parse(value));
	}

	parse(value: string, insertFinalTabstop?: boolean, enforceFinalTabstop?: boolean): Marker[] {
		const marker: Marker[] = [];

		this._scanner.text(value);
		this._token = this._scanner.next();
		while (this._parseAny(marker) || this._parseText(marker)) {
			// nothing
		}

		// * fill in default for empty placeHolders
		// * compact sibling Text markers
		function walk(marker: Marker[], placeholderDefaultValues: Map<number, Marker[]>) {

			for (let i = 0; i < marker.length; i++) {
				const thisMarker = marker[i];

				if (thisMarker instanceof Placeholder) {
					// fill in default values for repeated placeholders
					// like `${1:foo}and$1` becomes ${1:foo}and${1:foo}
					if (!placeholderDefaultValues.has(thisMarker.index)) {
						placeholderDefaultValues.set(thisMarker.index, thisMarker.children);
						walk(thisMarker.children, placeholderDefaultValues);

					} else if (thisMarker.children.length === 0) {
						// copy children from first placeholder definition, no need to
						// recurse on them because they have been visited already
						thisMarker.children = placeholderDefaultValues.get(thisMarker.index).map(child => child.clone());
					}


				} else if (thisMarker instanceof Variable) {
					walk(thisMarker.children, placeholderDefaultValues);

				} else if (i > 0 && thisMarker instanceof Text && marker[i - 1] instanceof Text) {
					(<Text>marker[i - 1]).string += (<Text>marker[i]).string;
					marker.splice(i, 1);
					i--;
				}
			}
		}

		const placeholderDefaultValues = new Map<number, Marker[]>();
		walk(marker, placeholderDefaultValues);

		if (
			!placeholderDefaultValues.has(0) && // there is no final tabstop
			(insertFinalTabstop && placeholderDefaultValues.size > 0 || enforceFinalTabstop)
		) {
			// the snippet uses placeholders but has no
			// final tabstop defined -> insert at the end
			marker.push(new Placeholder(0, []));
		}

		return marker;
	}

	private _accept(type: TokenType): boolean {
		if (type === undefined || this._token.type === type) {
			this._prevToken = this._token;
			this._token = this._scanner.next();
			return true;
		}
		return false;
	}

	private _parseAny(marker: Marker[]): boolean {
		if (this._parseEscaped(marker)) {
			return true;
		} else if (this._parseTM(marker)) {
			return true;
		}
		return false;
	}

	private _parseText(marker: Marker[]): boolean {
		if (this._token.type !== TokenType.EOF) {
			marker.push(new Text(this._scanner.tokenText(this._token)));
			this._accept(undefined);
			return true;
		}
		return false;
	}

	private _parseTM(marker: Marker[]): boolean {
		if (this._accept(TokenType.Dollar)) {

			if (this._accept(TokenType.VariableName) || this._accept(TokenType.Int)) {
				// $FOO, $123
				const idOrName = this._scanner.tokenText(this._prevToken);
				marker.push(/^\d+$/.test(idOrName) ? new Placeholder(Number(idOrName), []) : new Variable(idOrName, []));
				return true;

			} else if (this._accept(TokenType.CurlyOpen)) {
				// ${name:children}
				let name: Marker[] = [];
				let children: Marker[] = [];
				let target = name;

				while (true) {

					if (target !== children && this._accept(TokenType.Colon)) {
						target = children;
						continue;
					}

					if (this._accept(TokenType.CurlyClose)) {
						const idOrName = Marker.toString(name);
						marker.push(/^\d+$/.test(idOrName) ? new Placeholder(Number(idOrName), children) : new Variable(idOrName, children));
						return true;
					}

					if (this._parseAny(target) || this._parseText(target)) {
						continue;
					}

					// fallback
					if (children.length > 0) {
						marker.push(new Text('${' + Marker.toString(name) + ':'));
						marker.push(...children);
					} else {
						marker.push(new Text('${'));
						marker.push(...name);
					}
					return true;
				}
			}

			marker.push(new Text('$'));
			return true;
		}
		return false;
	}

	private _parseEscaped(marker: Marker[]): boolean {
		if (this._accept(TokenType.Backslash)) {
			if (this._accept(TokenType.Dollar) || this._accept(TokenType.CurlyClose) || this._accept(TokenType.Backslash)) {
				// just consume them
			}
			marker.push(new Text(this._scanner.tokenText(this._prevToken)));
			return true;
		}
		return false;
	}
}
